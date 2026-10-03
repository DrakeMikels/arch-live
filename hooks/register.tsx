import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  ArchAsk,
  ArchEdge,
  ArchEdgeStyle,
  ArchGraph,
  ArchKind,
  ArchNode,
  ArchTheme,
  CarryOffer,
  JournalDay,
  JournalEntry,
  JournalFile,
  JournalNote,
  JournalNoteType,
  JournalSession,
  PaneTab,
} from '../types'
import {
  buildStandup,
  carryOffer,
  componentFor,
  dateKey,
  dayLabel,
  dayMarkdown,
  emptyDay,
  isNote,
  labelsFrom,
  newId,
  openItems,
  parseWebLines,
  projectKey,
  resolveDays,
  resolveTag,
  snapshotOf,
  standupDetail,
  timeLabel,
} from './journal'
import { outline, popoutHtml, renderSvg } from './render'
import type { Overlay } from './render'
import { distill } from './ste'
import { DEFAULT_THEME, normalizeTheme, themeWarnings } from './theme'

const PANE = 'arch-live'
const GRAPH_FILE = '.claude/architecture.json'
const EXPORT_FILE = 'docs/architecture.svg'
const POPOUT_FILE = '.claude/architecture.html'
// Desktop panes report their width in character cells of about this many CSS
// pixels (measured: a 79-cell pane is about 550px wide).
const CELL_PX = 7
const UPDATE_TOOL = 'mcp__arch-live__arch_update'
const THEME_TOOL = 'mcp__arch-live__arch_theme'
const DECISION_TOOL = 'mcp__arch-live__log_decision'
const BLOCKER_TOOL = 'mcp__arch-live__log_blocker'
const TODO_TOOL = 'mcp__arch-live__log_todo'
const DESCRIBE_TOOL = 'mcp__arch-live__describe_files'
const STANDUP_TOOL = 'mcp__arch-live__save_standup'
const NOTE_COMMANDS: Record<string, JournalNoteType> = { n: 'note', todo: 'todo', blocker: 'blocker', decision: 'decision' }
const COMMANDS = ['arch', 'arch-map', 'arch-theme', 'arch-export', 'standup', 'done', 'notepad', ...Object.keys(NOTE_COMMANDS)]
const DAY_MS = 24 * 60 * 60 * 1000
const TABS: [PaneTab, string][] = [
  ['diagram', 'Diagram'],
  ['journal', 'Journal'],
  ['standup', 'Standup'],
]
const NOTE_TYPES: [JournalNoteType, string][] = [
  ['note', 'Note'],
  ['todo', 'Todo'],
  ['blocker', 'Blocker'],
  ['decision', 'Decision'],
]
const NOTE_PLACEHOLDER: Partial<Record<JournalNoteType, string>> = {
  note: 'Note… (@component to tag it)',
  todo: 'What is left to do…',
  blocker: 'What is blocking you…',
  decision: 'Decision… because why',
}
const KINDS: ArchKind[] = ['client', 'edge', 'service', 'worker', 'queue', 'store', 'external']
const STYLES: ArchEdgeStyle[] = ['call', 'http', 'async']
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml']

const graphAtom = atom({ plugin: 'arch-live', key: 'graph' } as const, null)
const themeAtom = atom({ plugin: 'arch-live', key: 'theme' } as const, null)
const askAtom = atom({ plugin: 'arch-live', key: 'ask' } as const, null)
// The mapped project, relative to the session folder ('' is the folder itself),
// so a session over a folder of several repos still finds its map.
const rootAtom = atom({ plugin: 'arch-live', key: 'root' } as const, '')
const rootGuessAtom = atom({ plugin: 'arch-live', key: 'rootGuess' } as const, false)
const tabAtom = atom({ plugin: 'arch-live', key: 'tab' } as const, 'diagram')
const jdateAtom = atom({ plugin: 'arch-live', key: 'jdate' } as const, '')
const jdayAtom = atom({ plugin: 'arch-live', key: 'jday' } as const, null)
const jdatesAtom = atom({ plugin: 'arch-live', key: 'jdates' } as const, [])
const openAtom = atom({ plugin: 'arch-live', key: 'open' } as const, [])
const activeAtom = atom({ plugin: 'arch-live', key: 'active' } as const, [])
const noteTypeAtom = atom({ plugin: 'arch-live', key: 'noteType' } as const, 'note')
const carryAtom = atom({ plugin: 'arch-live', key: 'carry' } as const, null)
const pendingAtom = atom({ plugin: 'arch-live', key: 'pending' } as const, null)
const markTargetAtom = atom({ plugin: 'arch-live', key: 'markTarget' } as const, null)
const notepadAtom = atom({ plugin: 'arch-live', key: 'notepad' } as const, null)

const SECTION = {
  id: 'arch-live:guide',
  scope: 'session' as const,
  text: [
    '# Live architecture (arch-live)',
    `This session shows a live system-architecture diagram, stored in ${GRAPH_FILE} of the mapped project.`,
    `When your work adds, removes, renames or rewires a system component (an app, service, worker, queue, data store, external API or client), call ${UPDATE_TOOL} in the same turn so the diagram stays true.`,
    'Keep it architectural: deployable components and the connections between them, not files, classes or functions. Changes inside a component need no update.',
    '',
    "The person keeps a work journal for their daily standup. Record what they would need to explain later:",
    `- ${DECISION_TOOL} when you make or recommend a design choice (what, why, and what else you considered).`,
    `- ${BLOCKER_TOOL} when something stops progress (a failing dependency, missing access, an open question for someone), and again with resolved: true once it is cleared.`,
    `- ${TODO_TOOL} for work left over at the end of a task, and with done: true when you finish an item already on the list.`,
    'Keep each entry to one plain sentence. Do not log routine edits; the journal records files and components by itself.',
    '',
    `When you create a file or change what one does (not small fixes), call ${DESCRIBE_TOOL} with a one-line summary for it, so the notepad's file view stays true.`,
  ].join('\n'),
}

const mapPrompt = (root: string) =>
  [
    `Map the system architecture of the project in ${root} for the arch-live diagram.`,
    'Explore the codebase: package manifests, workspace and docker-compose files, infra config, entry points and top-level directories. Identify the clients, edge (gateways, CDNs, routers), services and workers, queues, data stores and external APIs.',
    `Then call ${UPDATE_TOOL} once with replace: true, root: "${root}", the components and the connections between them. Stay at architecture level: 4 to 12 nodes, each a distinct deployable or system boundary. Give every node a path, relative to the project, to the file where its code starts (an entry point, route or handler, not a folder) and a line when that code sits inside a larger file, plus owns: the folders that belong to it. Mark the 1 or 2 components a newcomer should look at first as focus.`,
    `Then call ${DESCRIBE_TOOL} once per component with one plain sentence (under 15 words) for each of its key files: entry points, routes, handlers, models; up to 15 per component.`,
    `Finally, ask me whether to add an "Architecture" section to the README that embeds the diagram (/arch-export writes ${EXPORT_FILE}).`,
  ].join('\n\n')

const brandPrompt = (url: string) =>
  [
    `Extract design tokens from ${url} for my arch-live diagram style (saved for my account; every repo uses it).`,
    'Fetch the page and its linked stylesheets. Read the CSS custom properties, the most used colors, and the font families.',
    'Map them to these roles: paper (page and container background), paper2, ink (primary text and strokes), muted (secondary text, default arrows), soft (sublabels), rule (hairlines), accent (focal nodes only), accentTint (fill behind an accent stroke), link (HTTP/API arrows), nodeFill (service node fill). Leave fonts out: the person keeps JetBrains Mono.',
    "Constraints: ink and muted must reach WCAG AA on paper; exactly one accent hue, the brand's most distinctive; paper warm-neutral, never pure white; from an 8-color brand keep 3 (paper, ink, accent) and make the rest muted variants. Give a dark palette too, or leave it out and it is derived by swapping paper and ink.",
    `Call ${THEME_TOOL} with source: "${url}", fix anything its warnings flag, then show me the tokens in a short table.`,
  ].join('\n\n')

const describePrompt = (id: string, label: string, files: string[]) =>
  [
    `Describe the files of the ${label} component for my arch-live notepad.`,
    'For each file below, read enough of it to write one plain sentence (under 15 words) on what it does. Skip generated or trivial files.',
    `Then call ${DESCRIBE_TOOL} with component "${id}" and all of the summaries in one call. Reply with one short line when done.`,
    '',
    ...files.map(f => `- ${f}`),
  ].join('\n')

const boardPrompt = (title: string, png: string, md: string, note: string) =>
  [
    `I sketched this on my arch-live whiteboard ("${title}").${note ? ` ${note}` : ''}`,
    '',
    `The drawing is saved at ${png}. Read that image to see the layout: shapes, arrows, what is circled or connected to what.`,
    ...(md.trim() ? ['', 'Text and code on the board, exactly as written:', '', md.trim()] : []),
    ...(note ? [] : ['', 'Tell me briefly what you make of it, then ask what I want to do with it.']),
  ].join('\n')

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    root: {
      type: 'string',
      description: 'The project folder: a full path, or relative to the session folder. Omitted, the current one.',
    },
    title: { type: 'string', description: 'Diagram title, e.g. the product name.' },
    replace: { type: 'boolean', description: 'Start from an empty diagram instead of merging (use for a full re-map).' },
    nodes: {
      type: 'array',
      description: 'Components to add, or to update by id.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable kebab-case id, e.g. "orders-api".' },
          label: { type: 'string', description: 'Human name, e.g. "Orders API".' },
          kind: { type: 'string', enum: KINDS },
          sublabel: { type: 'string', description: 'Technical detail in mono: stack, port or protocol, e.g. "Next.js · :3000".' },
          path: { type: 'string', description: 'Project-relative file where the code starts: an entry point, route or handler. A folder opens on its entry file.' },
          line: { type: 'number', description: 'Entry-point line within path, when path is a file.' },
          owns: { type: 'array', items: { type: 'string' }, description: 'Project-relative folders that belong to this component, for matching edits to it.' },
        },
        required: ['id'],
      },
    },
    edges: {
      type: 'array',
      description: 'Connections to add, or to update by from+to.',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string', description: 'Short arrow label, e.g. "REST", "publishes", "SQL".' },
          style: { type: 'string', enum: STYLES, description: 'http: HTTP/API call; async: event or queue; call: anything else.' },
        },
        required: ['from', 'to'],
      },
    },
    remove_nodes: { type: 'array', items: { type: 'string' }, description: 'Ids to remove, with their edges.' },
    remove_edges: {
      type: 'array',
      items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    },
    focus: {
      type: 'array',
      items: { type: 'string' },
      description: 'At most 2 ids drawn in the accent color. Omitted, the nodes this call added or changed are accented when there are 2 or fewer.',
    },
  },
}

const PALETTE_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(Object.keys(DEFAULT_THEME.light).map(k => [k, { type: 'string', description: 'Hex or rgba() color.' }])),
}

const THEME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Name of the style, e.g. "Acme brand".' },
    source: { type: 'string', description: 'Where it came from: the URL, file or "pasted".' },
    mode: { type: 'string', enum: ['auto', 'light', 'dark'], description: "auto follows the viewer's light/dark setting." },
    light: PALETTE_SCHEMA,
    dark: PALETTE_SCHEMA,
    fonts: {
      type: 'object',
      properties: { serif: { type: 'string' }, sans: { type: 'string' }, mono: { type: 'string' } },
    },
  },
  required: ['light'],
}

type NodeInput = Partial<Omit<ArchNode, 'order'>> & { id?: unknown }
type UpdateArgs = {
  root?: string
  title?: string
  replace?: boolean
  nodes?: NodeInput[]
  edges?: Partial<ArchEdge>[]
  remove_nodes?: string[]
  remove_edges?: { from: string; to: string }[]
  focus?: string[]
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

// JSON for $.state: no undefined anywhere.
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const cleanRoot = (root: unknown) =>
  typeof root === 'string' ? root.trim().replace(/^\.\/+/, '').replace(/\/+$/, '').replace(/(^|\/)\.\.(\/|$)/g, '') : ''

const inRoot = (root: string, path: string) => (root ? `${root}/${path}` : path)

const homeThemePath = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? '~'}/.claude/arch-live/theme.json`

// The project folder as a full path. A relative one would follow the session's
// folder, which moves whenever the shell changes directory.
const absRoot = async ($: EngineInterface, root: string) => {
  if (root.startsWith('/')) return root
  const cwd = await $.session.cwd()
  return root ? `${cwd}/${root}` : cwd
}

const currentRoot = async ($: EngineInterface) => absRoot($, (await $.state.get({ plugin: 'arch-live', key: 'root' })).value ?? '')

const currentTheme = async ($: EngineInterface) =>
  (await $.state.get({ plugin: 'arch-live', key: 'theme' })).value ?? DEFAULT_THEME

const loadGraph = async ($: EngineInterface, root: string): Promise<ArchGraph | null> => {
  const file = inRoot(root, GRAPH_FILE)
  if (!(await $.fs.exists(file))) return null
  const raw = parseJson(await $.fs.read(file)) as Partial<ArchGraph> | undefined
  if (!raw || !Array.isArray(raw.nodes)) return null
  return plain({
    version: 1 as const,
    title: raw.title,
    nodes: raw.nodes
      .filter(n => n && typeof n.id === 'string')
      .map((n, i) => ({ ...n, kind: KINDS.includes(n.kind) ? n.kind : 'service', label: n.label || n.id, order: n.order ?? i })),
    edges: Array.isArray(raw.edges) ? raw.edges.filter(e => e && e.from && e.to) : [],
    focus: Array.isArray(raw.focus) ? raw.focus.slice(0, 2) : [],
    updatedAt: raw.updatedAt ?? 0,
  })
}

// The session folder's own map, else the most recently updated map one level
// down (a folder of repos), else nothing.
const findRoot = async ($: EngineInterface): Promise<string> => {
  const cwd = await $.session.cwd()
  if (await $.fs.exists(GRAPH_FILE)) return cwd
  const entries = await $.fs.list().catch(() => [])
  let best = { root: '', mtime: -1 }
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    const file = `${entry.name}/${GRAPH_FILE}`
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (stat && stat.mtimeMs > best.mtime) best = { root: entry.name, mtime: stat.mtimeMs }
  }
  return best.root ? `${cwd}/${best.root}` : cwd
}

const reloadAfter = async ($: EngineInterface, filePath: string) => {
  if (!filePath.endsWith(GRAPH_FILE)) return
  const graph = await loadGraph($, await currentRoot($)).catch(() => null)
  await update($, graphAtom, () => graph)
  await writePopout($, graph, await currentTheme($))
}

const applyUpdate = (prev: ArchGraph | null, args: UpdateArgs, now: number) => {
  const base: ArchGraph = !prev || args.replace ? { version: 1, nodes: [], edges: [], focus: [], updatedAt: now } : prev
  const problems: string[] = []
  const touched: string[] = []
  const removed = new Set(args.remove_nodes ?? [])
  let nodes = base.nodes.filter(n => !removed.has(n.id))
  let order = Math.max(-1, ...base.nodes.map(n => n.order)) + 1

  for (const input of args.nodes ?? []) {
    if (typeof input.id !== 'string' || !input.id.trim()) {
      problems.push('a node without an id was skipped')
      continue
    }
    const id = input.id.trim()
    const kind = input.kind && KINDS.includes(input.kind) ? input.kind : undefined
    if (input.kind && !kind) problems.push(`${id}: unknown kind "${input.kind}", kept as service`)
    const found = nodes.find(n => n.id === id)
    const patch = {
      ...(input.label ? { label: input.label } : {}),
      ...(kind ? { kind } : {}),
      ...(input.sublabel !== undefined ? { sublabel: input.sublabel || undefined } : {}),
      ...(input.path !== undefined ? { path: input.path || undefined } : {}),
      ...(typeof input.line === 'number' ? { line: input.line } : {}),
      ...(Array.isArray(input.owns) ? { owns: input.owns.filter(o => typeof o === 'string').slice(0, 8) } : {}),
    }
    if (found) {
      nodes = nodes.map(n => (n.id === id ? { ...n, ...patch } : n))
    } else {
      nodes.push({ id, label: input.label || id, kind: kind ?? 'service', order: order++, ...patch })
    }
    touched.push(id)
  }

  const ids = new Set(nodes.map(n => n.id))
  const gone = (e: { from?: string; to?: string }) => (args.remove_edges ?? []).some(r => r.from === e.from && r.to === e.to)
  let edges = base.edges.filter(e => ids.has(e.from) && ids.has(e.to) && !gone(e))
  for (const input of args.edges ?? []) {
    if (!input.from || !input.to || !ids.has(input.from) || !ids.has(input.to)) {
      problems.push(`edge ${input.from} → ${input.to} names an unknown node and was skipped`)
      continue
    }
    const style = input.style && STYLES.includes(input.style) ? input.style : undefined
    const edge: ArchEdge = { from: input.from, to: input.to, ...(input.label ? { label: input.label } : {}), ...(style ? { style } : {}) }
    const at = edges.findIndex(e => e.from === edge.from && e.to === edge.to)
    edges = at >= 0 ? edges.map((e, i) => (i === at ? { ...e, ...edge } : e)) : [...edges, edge]
  }

  const focus = (args.focus ?? (touched.length <= 2 ? touched : [])).filter(id => ids.has(id)).slice(0, 2)
  const graph: ArchGraph = plain({ version: 1, title: args.title ?? base.title, nodes, edges, focus, updatedAt: now })
  return { graph, problems }
}

// Rewrites the browser view; only once the person has opened it, unless `force`.
// The read-only browser view lives with the journal, not in the repo: a file
// written into the mod's own folder would reload the mod in every session.
const popoutFile = async ($: EngineInterface) => `${await logsDir($)}/architecture.html`

const writePopout = async ($: EngineInterface, graph: ArchGraph | null, theme: ArchTheme, force = false) => {
  const file = await popoutFile($)
  if (!force && !(await $.fs.exists(file))) return
  await $.fs.write(file, popoutHtml(renderSvg(graph, theme), theme))
}

// The browser notepad: a small local server shipped with the mod, started once
// per session and stopped with it. Without Node it falls back to a static page.
let notepadStarting: Promise<string | undefined> | undefined
// Why the last start failed, so the fallback says what actually went wrong.
let notepadError: string | undefined

const startNotepad = async ($: EngineInterface): Promise<string | undefined> => {
  await publishLive($).catch(() => undefined)
  const argv = [
    `${$.plugin.root}/notepad/server.mjs`,
    '--logs',
    await logsDir($),
    '--project',
    await projectPath($),
    '--session',
    await $.session.id(),
  ]
  const reasons: string[] = []
  for (const node of ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    const url = await new Promise<string | undefined>(resolve => {
      void (async () => {
        let isResolved = false
        let stderr = ''
        try {
          for await (const chunk of $.process.spawn({ argv: [node, ...argv] })) {
            if (chunk.stream === 'stderr' && !isResolved) stderr += chunk.text
            if (chunk.text.includes('BUSY') && !isResolved) {
              isResolved = true
              resolve(undefined)
            }
            const found = /NOTEPAD (http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/.exec(chunk.text)
            if (found && !isResolved) {
              isResolved = true
              resolve(found[1])
            }
            // The notepad prints CHANGED after each note, check-off or standup it
            // saves, and ASK {json} when the person sends something to Claude.
            if (chunk.text.includes('CHANGED')) void refreshJournal($).catch(() => undefined)
            for (const line of chunk.text.split('\n')) {
              if (line.startsWith('ASK ')) void handleAsk($, line.slice(4)).catch(() => undefined)
            }
          }
        } catch {
          // This node could not start; the next is tried.
        }
        if (!isResolved || stderr.includes('BUSY')) {
          // Node ran but the server failed: keep its first error line.
          const line = stderr.split('\n').map(l => l.trim()).find(l => /error|denied|not permitted|cannot/i.test(l))
          if (line) reasons.push(line.slice(0, 160))
          resolve(undefined)
        }
        else await update($, notepadAtom, () => null)
      })()
    })
    if (url) {
      notepadError = undefined
      await update($, notepadAtom, () => url)
      return url
    }
  }
  notepadError = reasons[0] ?? 'Node was not found'
  return undefined
}

type NotepadAsk =
  | { kind: 'describe'; component: string; label: string; files: string[] }
  | { kind: 'board'; title: string; png: string; md: string; note: string; target?: string; targetName?: string }
  | { kind: 'standup'; scope: 'all' | 'session' }

// A request the person made in the notepad, run as a prompt in this session.
const handleAsk = async ($: EngineInterface, json: string) => {
  const request = parseJson(json) as NotepadAsk | undefined
  if (!request) return
  if (request.kind === 'describe') {
    if (request.files.length === 0) {
      $.ui.toast(`arch-live: every ${request.label} file already has a summary`)
      return
    }
    submitSoon($, describePrompt(request.component, request.label, request.files))
    $.ui.toast(`arch-live: asked Claude to describe ${request.files.length} ${request.label} files`)
  } else if (request.kind === 'standup') {
    await askForStandup($, request.scope === 'session')
  } else if (request.kind === 'board') {
    const text = boardPrompt(request.title, request.png, request.md, request.note)
    if (request.target && request.target !== (await $.session.id())) {
      // Another session on the project: it gets the board as a message there.
      const where = request.targetName ?? 'another session'
      try {
        await $.session.send({ to: { sessionId: request.target }, text: `The person sent you a whiteboard from their arch-live notepad.\n\n${text}` })
        await addNote($, 'note', `Sent the whiteboard "${request.title}" to ${where}`, 'you')
        $.ui.toast(`arch-live: sent "${request.title}" to ${where}`)
      } catch (err) {
        $.ui.toast(`arch-live: could not reach ${where} (${errorText(err)}); is it still open?`)
      }
      return
    }
    submitSoon($, text)
    await addNote($, 'note', `Sent the whiteboard "${request.title}" to Claude`, 'you')
  }
}

// The project's notepad, if one answers: any session's server serves every
// session on the project, at the address kept in logs/<project>/notepad.json.
const liveNotepad = async ($: EngineInterface): Promise<string | undefined> => {
  const info = parseJson(await $.fs.read(`${await logsDir($)}/notepad.json`).catch(() => '')) as { token?: string; port?: number } | undefined
  if (!info?.token || !info.port) return undefined
  const base = `http://127.0.0.1:${info.port}`
  const ping = $.http.fetch(`${base}/api/ping?t=${info.token}`).then(r => r.ok, () => false)
  const isUp = await Promise.race([ping, new Promise<boolean>(resolve => $.clock.after(1500, () => resolve(false)))])
  return isUp ? `${base}/?t=${info.token}` : undefined
}

// The running notepad, else one this session starts; if another session wins
// the start, its server is the notepad.
const ensureNotepad = async ($: EngineInterface): Promise<string | undefined> => {
  const live = await liveNotepad($)
  if (live) return live
  notepadStarting ??= startNotepad($).finally(() => {
    notepadStarting = undefined
  })
  return (await notepadStarting) ?? (await liveNotepad($))
}

// Runs for the module's life (a reload starts a fresh one): reads this
// session's inbox from the notepad, refreshes the pane when a notepad changes
// the journal, and takes over the notepad when the session serving it goes.
let booted = false
let journalSig = ''
let ticks = 0
const boot = ($: EngineInterface) => {
  if (booted) return
  booted = true
  $.clock.every(2000, () => {
    void tick($).catch(() => undefined)
  })
}
const tick = async ($: EngineInterface) => {
  ticks += 1
  const dir = await logsDir($)
  const inbox = `${dir}/inbox/${await $.session.id()}.jsonl`
  const asks = await $.fs.read(inbox).catch(() => '')
  if (asks.trim()) {
    await $.fs.write(inbox, '')
    for (const line of asks.split('\n')) if (line.trim()) await handleAsk($, line).catch(() => undefined)
  }
  const today = dateKey(await $.clock.now())
  const stamps = await Promise.all(
    [`${today}.json`, `${today}.web.jsonl`, 'standup.json', 'standup-written.json'].map(f =>
      $.fs.stat(`${dir}/${f}`).then(st => st.mtimeMs, () => 0),
    ),
  )
  const sig = `${today}|${stamps.join(',')}`
  if (sig !== journalSig) {
    const isFirst = journalSig === ''
    journalSig = sig
    if (!isFirst) await refreshJournal($)
  }
  if (ticks % 5 === 1 && (await read($, graphAtom))) await ensureNotepad($)
}

const openPopout = async ($: EngineInterface) => {
  try {
    const url = await ensureNotepad($)
    if (url) {
      await $.process.run(['open', `${url}&s=${encodeURIComponent(await $.session.id())}`])
      return
    }
    const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
    await writePopout($, graph, await currentTheme($), true)
    const file = await popoutFile($)
    const ran = await $.process.run(['open', file])
    if (ran.exitCode !== 0) $.ui.toast(`arch-live: could not open the browser view (${ran.stderr.trim() || ran.exitCode})`)
    else $.ui.toast(`arch-live: the notepad server did not start (${notepadError ?? 'Node was not found'}), so the browser view is read-only`)
  } catch (err) {
    $.ui.toast(`arch-live: ${errorText(err)}`)
  }
}

// A command or press cannot start a turn itself; queue the prompt just after.
const submitSoon = ($: EngineInterface, text: string) => {
  $.clock.after(50, () => {
    $.prompt.submit({ text }).catch(err => $.ui.toast(`arch-live: could not ask Claude (${errorText(err)})`))
  })
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Architecture' })

// The file a folder node opens on: a conventional entry point, else its first
// code file, else the same one level or two down.
const ENTRY_NAMES = ['page.tsx', 'page.ts', 'layout.tsx', 'route.ts', 'index.ts', 'index.tsx', 'index.js', 'main.ts', 'main.py', 'app.py', 'server.ts', 'server.js', 'handler.py', 'README.md']
const CODE_FILE = /\.(tsx?|jsx?|mjs|py|go|rs|rb|java|kt|swift|sql)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next'])

const entryFile = async ($: EngineInterface, dir: string, depth = 0): Promise<string | undefined> => {
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter(e => e.kind === 'file').map(e => e.name)
  const named = ENTRY_NAMES.find(name => files.includes(name))
  if (named) return `${dir}/${named}`
  const code = files.filter(name => CODE_FILE.test(name)).sort()[0]
  if (code) return `${dir}/${code}`
  if (depth >= 2) return undefined
  const dirs = entries
    .filter(e => e.kind === 'dir' && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map(e => e.name)
    .sort()
  for (const sub of dirs) {
    const found = await entryFile($, `${dir}/${sub}`, depth + 1)
    if (found) return found
  }
  return undefined
}

// Opens a node's code in the person's editor, inside the project's window:
// the file at its line, or a folder's entry file. VS Code's or Cursor's CLI
// (`code` is often Cursor's), else the system default for the file.
const openInEditor = async ($: EngineInterface, path: string, line?: number) => {
  const project = await currentRoot($)
  const abs = path.startsWith('/') ? path : `${project}/${path.replace(/^\.\//, '')}`
  const stat = await $.fs.stat(abs).catch(() => undefined)
  if (!stat) {
    $.ui.toast(`arch-live: ${path} is not in the project any more; re-map to fix it`)
    return
  }
  const file = stat.kind === 'dir' ? await entryFile($, abs) : abs
  const target = file ? `${file}:${stat.kind === 'dir' ? 1 : (line ?? 1)}` : abs
  const clis = ['code', 'cursor', '/Applications/Cursor.app/Contents/Resources/app/bin/cursor']
  for (const cli of clis) {
    const ran = await $.process.run([cli, project, '-g', target]).catch(() => undefined)
    if (ran && ran.exitCode === 0) return
  }
  const ran = await $.process.run(['open', file ?? abs]).catch(() => undefined)
  if (!ran || ran.exitCode !== 0) $.ui.toast(`arch-live: could not open ${path}`)
}

const setDefaultTheme = async ($: EngineInterface) => {
  await $.fs.write(await homeThemePath($), `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`)
  await update($, themeAtom, () => DEFAULT_THEME)
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  await writePopout($, graph, DEFAULT_THEME)
}

const startMap = async ($: EngineInterface, folder: string) => {
  const root = folder.trim() ? await absRoot($, cleanRoot(folder)) : await currentRoot($)
  await update($, rootAtom, () => root)
  await update($, rootGuessAtom, () => false)
  await update($, askAtom, () => null)
  submitSoon($, mapPrompt(root))
  // The prompt waits while Claude is busy; say so, or the button looks dead.
  $.ui.toast(`arch-live: asked Claude to map ${root.split('/').pop()}; it starts when Claude is free`)
  void openPane($)
}

const startBrand = ($: EngineInterface, url: string) => {
  const trimmed = url.trim()
  const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(href)) {
    $.ui.toast('arch-live: enter a website address, like acme.com')
    return
  }
  // Tracking parameters (utm_*, gclid, ...) say nothing about the brand.
  const clean = href.replace(/[?#].*$/, '')
  void update($, askAtom, () => null)
  submitSoon($, brandPrompt(clean))
  $.ui.toast(`arch-live: asked Claude to read ${clean.replace(/^https?:\/\//, '')}; it starts when Claude is free`)
}

const exportSvg = async ($: EngineInterface): Promise<string> => {
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  if (!graph) return 'Nothing to export yet: run /arch-map first.'
  const root = await currentRoot($)
  await $.fs.write(inRoot(root, EXPORT_FILE), `${renderSvg(graph, await currentTheme($)).svg}\n`)
  return `Wrote ${inRoot(root, EXPORT_FILE)}. Embed it with ![Architecture](${EXPORT_FILE}).`
}

const LOG_SCHEMA_COMPONENT = { type: 'string', description: 'The architecture node id this is about, when there is one.' }

const projectPath = async ($: EngineInterface) => currentRoot($)

// Whose journal this session writes: its project, or, while the project is
// only a guess in a folder of repos, that folder's own journal, so work is
// never filed under a repo it did not touch.
const journalPath = async ($: EngineInterface) => ((await read($, rootGuessAtom)) ? $.session.cwd() : projectPath($))

const logsDir = async ($: EngineInterface) =>
  `${(await $.env.get('HOME')) ?? '~'}/.claude/arch-live/logs/${projectKey(await journalPath($))}`

// The day file the mod owns (<date>.json); the notepad appends to <date>.web.jsonl.
const readRawDay = async ($: EngineInterface, date: string): Promise<JournalDay> => {
  const text = await $.fs.read(`${await logsDir($)}/${date}.json`).catch(() => undefined)
  const raw = text ? (parseJson(text) as JournalDay | undefined) : undefined
  return raw && Array.isArray(raw.entries) ? raw : emptyDay(date, await projectPath($))
}

const readDay = async ($: EngineInterface, date: string): Promise<JournalDay> => {
  const day = await readRawDay($, date)
  const web = await $.fs.read(`${await logsDir($)}/${date}.web.jsonl`).catch(() => '')
  return web ? { ...day, entries: [...day.entries, ...parseWebLines(web)] } : day
}

// Journal writes run one at a time, so two hooks never overwrite each other's day.
let journalQueue: Promise<unknown> = Promise.resolve()

const changeDay = ($: EngineInterface, date: string, change: (day: JournalDay) => JournalDay) => {
  const run = journalQueue.then(async () => {
    const day = change(await readRawDay($, date))
    await $.fs.write(`${await logsDir($)}/${date}.json`, `${JSON.stringify(plain(day), null, 2)}\n`)
    return day
  })
  journalQueue = run.catch(() => undefined)
  return run
}

// Each session on the project keeps its own small file, so sessions running
// side by side never write the same one. The notepad lists and renames them.
const sessionFile = async ($: EngineInterface) => `${await logsDir($)}/sessions/${await $.session.id()}.json`

const changeSession = async ($: EngineInterface, change: (s: JournalSession) => JournalSession) => {
  const file = await sessionFile($)
  const now = await $.clock.now()
  const prev = parseJson(await $.fs.read(file).catch(() => '')) as JournalSession | undefined
  const base: JournalSession = prev?.id ? prev : { id: await $.session.id(), startedAt: now, lastAt: now }
  await $.fs.write(file, `${JSON.stringify(plain(change({ ...base, lastAt: now })), null, 2)}\n`)
}

// Session names by id, for the standup.
const sessionNames = async ($: EngineInterface): Promise<Record<string, string>> => {
  const dir = `${await logsDir($)}/sessions`
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.name.endsWith('.json'))
  const names: Record<string, string> = {}
  for (const f of files) {
    const one = parseJson(await $.fs.read(`${dir}/${f.name}`).catch(() => '')) as JournalSession | undefined
    if (one?.id && one.name) names[one.id] = one.name
  }
  return names
}

const appendEntry = async ($: EngineInterface, given: JournalEntry) => {
  const entry = given.session ? given : { ...given, session: await $.session.id() }
  const day = await changeDay($, dateKey(entry.ts), d => ({ ...d, entries: [...d.entries, entry] }))
  await refreshJournal($).catch(() => undefined)
  return day
}

// Keeps the day's opening map (as it stood before the first change) and its latest.
const saveSnapshot = async ($: EngineInterface, graph: ArchGraph, before?: ArchGraph | null) => {
  const now = await $.clock.now()
  return changeDay($, dateKey(now), day => ({
    ...day,
    opening: day.opening ?? snapshotOf(before ?? graph, now - 1),
    snapshot: snapshotOf(graph, now),
  }))
}

// The journal's days, oldest first, from `fromDate` on.
const loadDays = async ($: EngineInterface, fromDate: string): Promise<JournalDay[]> => {
  const entries = await $.fs.list(await logsDir($)).catch(() => [])
  const dates = [
    ...new Set(
      entries
        .map(e => /^(\d{4}-\d{2}-\d{2})\.(?:json|web\.jsonl)$/.exec(e.name)?.[1])
        .filter((d): d is string => d !== undefined && d >= fromDate),
    ),
  ].sort()
  return resolveDays(await Promise.all(dates.map(date => readDay($, date))))
}

const recentDays = async ($: EngineInterface) => loadDays($, dateKey((await $.clock.now()) - 60 * DAY_MS))

// Today's marks (component → its latest open mark), drawn on the map.
const marksOf = (day: JournalDay | null): Record<string, string> => {
  const marks: Record<string, string> = {}
  for (const e of day?.entries ?? []) if (isNote(e) && e.type === 'mark' && e.component && !e.done) marks[e.component] = e.text
  return marks
}

// What the notepad in the browser reads: the drawn map and the project's facts.
const publishLive = async ($: EngineInterface) => {
  const dir = await logsDir($)
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  const theme = await currentTheme($)
  const now = await $.clock.now()
  const today = (await recentDays($)).find(d => d.date === dateKey(now)) ?? null
  const active = (await $.state.get({ plugin: 'arch-live', key: 'active' })).value ?? []
  const overlay: Overlay = { marks: marksOf(today), active, ids: true }
  await $.fs.write(`${dir}/live.svg`, renderSvg(graph, theme, undefined, overlay).svg)
  const meta = {
    project: await projectPath($),
    title: graph?.title ?? (await projectPath($)).split('/').pop() ?? 'Project',
    nodes: (graph?.nodes ?? []).map(n => ({ id: n.id, label: n.label, kind: n.kind, path: n.path ?? null, line: n.line ?? null })),
    theme: { light: theme.light, dark: theme.dark, fonts: theme.fonts, mode: theme.mode },
    updatedAt: now,
  }
  await $.fs.write(`${dir}/meta.json`, `${JSON.stringify(meta, null, 2)}\n`)
}

// Reloads what the Journal tab shows: the days there are, the chosen day, open items.
// Re-reads everything the pane draws from disk: the theme, which project's map
// to show, the map itself and the journal. For edits made outside this
// session (another session, your editor, git) that no hook saw.
const refreshAll = async ($: EngineInterface) => {
  const themeText = await $.fs.read(await homeThemePath($)).catch(() => undefined)
  const theme = themeText ? plain(normalizeTheme(parseJson(themeText))) : null
  const isGuess = await read($, rootGuessAtom)
  const kept = !isGuess && (await read($, rootAtom)) ? await currentRoot($) : undefined
  const root = kept ?? (await findRoot($))
  const graph = await loadGraph($, root).catch(() => null)
  await update($, themeAtom, () => theme)
  await update($, rootAtom, () => root)
  const cwd = await $.session.cwd()
  if (!kept) await update($, rootGuessAtom, () => root !== cwd)
  await update($, graphAtom, () => graph)
  await refreshJournal($).catch(() => undefined)
  await writePopout($, graph, theme ?? DEFAULT_THEME).catch(() => undefined)
  $.ui.toast(graph ? `arch-live: refreshed (${graph.nodes.length} components)` : 'arch-live: refreshed, no map found')
}

const refreshJournal = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const today = dateKey(now)
  const days = await recentDays($)
  // An empty choice follows today, so a session left open overnight rolls over.
  const chosen = (await $.state.get({ plugin: 'arch-live', key: 'jdate' })).value || today
  const dates = [...new Set([today, ...days.map(d => d.date)])].sort().reverse()
  const day = days.find(d => d.date === chosen) ?? emptyDay(chosen, await projectPath($))
  await update($, jdatesAtom, () => dates)
  await update($, jdayAtom, () => plain(day))
  await update($, openAtom, () => plain(openItems(days)))
  await publishLive($).catch(() => undefined)
}

const showDay = async ($: EngineInterface, date: string) => {
  const today = dateKey(await $.clock.now())
  await update($, jdateAtom, () => (date === today ? '' : date))
  await refreshJournal($)
}

const standupFile = async ($: EngineInterface) => `${await logsDir($)}/standup.json`

const lastStandup = async ($: EngineInterface): Promise<number> => {
  const text = await $.fs.read(await standupFile($)).catch(() => undefined)
  const fromFile = text ? Number((parseJson(text) as { last?: number } | undefined)?.last ?? 0) : 0
  if (fromFile) return fromFile
  return Number((await $.store.get(`standup:${projectKey(await projectPath($))}`)) ?? 0)
}

type StandupDraft = { markdown: string; scope?: string; at: number }
type StandupRecord = {
  id: string
  at: number
  since: number
  until: number
  title: string
  scope: string
  written: string | null
  writtenAt: number | null
  drafts: StandupDraft[]
  brief: string
}

// Claude's write-ups since the last archive, oldest first; each one is added,
// never replacing the last (standup-written.json is the older single file).
const writtenFile = async ($: EngineInterface) => `${await logsDir($)}/standup-written.json`
const draftsFile = async ($: EngineInterface) => `${await logsDir($)}/standup-drafts.json`
const readDrafts = async ($: EngineInterface): Promise<StandupDraft[]> => {
  const list = (parseJson(await $.fs.read(await draftsFile($)).catch(() => '')) as { drafts?: StandupDraft[] } | undefined)?.drafts ?? []
  const legacy = parseJson(await $.fs.read(await writtenFile($)).catch(() => '')) as StandupDraft | undefined
  const all = legacy?.markdown && !list.some(d => d.at === legacy.at) ? [...list, legacy] : list
  const last = await lastStandup($)
  return all.filter(d => d?.markdown && d.at >= last).sort((a, b) => a.at - b.at)
}

const archivedStandups = async ($: EngineInterface): Promise<StandupRecord[]> => {
  const dir = `${await logsDir($)}/standups`
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.name.endsWith('.json'))
  const all = await Promise.all(files.map(async f => parseJson(await $.fs.read(`${dir}/${f.name}`).catch(() => '')) as StandupRecord | undefined))
  return all.filter((a): a is StandupRecord => !!a?.id).sort((a, b) => b.at - a.at)
}

// Archive & start fresh: the window's latest write-up, earlier drafts and the
// journal brief are saved first; only then does the window move, so a failed
// save leaves everything as it was.
const markStandupGiven = async ($: EngineInterface): Promise<StandupRecord> => {
  const now = await $.clock.now()
  const since = await standupSince($, now)
  const list = await readDrafts($)
  const latest = list[list.length - 1]
  const d = new Date(now)
  const two = (n: number) => String(n).padStart(2, '0')
  const id = `${dateKey(now)}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  const record: StandupRecord = {
    id,
    at: now,
    since,
    until: now,
    title: graph?.title ?? (await projectPath($)).split('/').pop() ?? 'Project',
    scope: latest?.scope ?? 'all sessions',
    written: latest?.markdown ?? null,
    writtenAt: latest?.at ?? null,
    drafts: list.slice(0, -1),
    brief: await standupText($),
  }
  await $.fs.write(`${await logsDir($)}/standups/${id}.json`, `${JSON.stringify(plain(record), null, 2)}\n`)
  await $.fs.write(await standupFile($), `${JSON.stringify({ last: now })}\n`)
  await $.fs.write(await draftsFile($), `${JSON.stringify({ drafts: [] })}\n`)
  if (await $.fs.exists(await writtenFile($))) await $.fs.write(await writtenFile($), '{}\n')
  return record
}

const standupSince = async ($: EngineInterface, now: number) => {
  const last = await lastStandup($)
  return last > now - 14 * DAY_MS ? last : now - DAY_MS
}


const standupPrompt = (scope: string, since: number, brief: string, detail: string) =>
  [
    `Write my standup notes for this morning's engineering meeting from my arch-live work journal (${scope}, since ${dayLabel(since)} ${timeLabel(since)}).`,
    'Markdown, in this order. Short plain bullets about outcomes, not activity. Group related work into one bullet and start it with the area in bold when that helps. No file paths unless they matter to the team.',
    '## Accomplished\n## In progress\n## Blockers (write "None" when there are none)\n## Next\n## Decisions (only when there are any)\n## Heads-up (only when useful: risks, asks, things others should know)',
    'Leave out noise: repeated or test notes, and checks of the tooling itself, unless that was the work. When the journal is unclear, you may read `git log` in the project for the same window.',
    `Then call ${STANDUP_TOOL} once with the Markdown and scope "${scope}". Reply with one short line when done.`,
    '',
    'Journal brief:',
    '',
    brief,
    '',
    'Every turn and note, oldest first:',
    '',
    detail,
  ].join('\n')

// One click: the window's journal goes to Claude, which writes the standup
// and saves it with save_standup.
const askForStandup = async ($: EngineInterface, isSession: boolean) => {
  const now = await $.clock.now()
  const since = await standupSince($, now)
  const me = await $.session.id()
  const all = await recentDays($)
  const days = isSession ? all.map(d => ({ ...d, entries: d.entries.filter(e => e.session === me) })) : all
  const sessions = await sessionNames($)
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  const title = graph?.title ?? (await projectPath($)).split('/').pop() ?? 'Project'
  const brief = buildStandup({ title, since, now, days, graph, sessions })
  const scope = isSession ? `this session: ${sessions[me] ?? 'unnamed'}` : 'all sessions'
  submitSoon($, standupPrompt(scope, since, brief, standupDetail({ since, days, sessions })))
  $.ui.toast('arch-live: asked Claude to write your standup; it starts when Claude is free')
}

const standupText = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const since = await standupSince($, now)
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  const title = graph?.title ?? (await projectPath($)).split('/').pop() ?? 'Project'
  return buildStandup({ title, since, now, days: await recentDays($), graph, sessions: await sessionNames($) })
}

const copyText = async ($: EngineInterface, text: string) => {
  // The desktop app is a remote surface the engine cannot copy on; pbcopy can.
  const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) return true
  const ran = await $.process.run(['pbcopy'], { stdin: text }).catch(() => undefined)
  return ran?.exitCode === 0
}

// Marks the open todo or blocker best matching `query` as done; answers it.
const closeItem = async (
  $: EngineInterface,
  types: JournalNoteType[],
  query: string,
  by: 'you' | 'claude' = 'you',
): Promise<JournalNote | undefined> => {
  const now = await $.clock.now()
  const q = query.trim().toLowerCase()
  const hit = [...openItems(await recentDays($))]
    .reverse()
    .find(n => types.includes(n.type) && (n.id === query.trim() || n.text.toLowerCase().includes(q)))
  if (!hit) return undefined
  await appendEntry($, { id: newId(now), ts: now, type: 'done', ref: hit.id, by })
  return hit
}

const addNote = async ($: EngineInterface, type: JournalNoteType, raw: string, by: 'you' | 'claude', extra: Partial<JournalNote> = {}) => {
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  const tagged = resolveTag(graph, raw)
  const now = await $.clock.now()
  let text = tagged.text
  let why = extra.why
  if (type === 'decision' && !why) {
    const parts = /^(.*?)\s+because\s+(.*)$/i.exec(text)
    if (parts) [text, why] = [parts[1] ?? text, parts[2]]
  }
  const note: JournalNote = plain({
    id: newId(now),
    ts: now,
    type,
    text,
    by,
    component: extra.component ?? tagged.component ?? lastComponent,
    ...(why ? { why } : {}),
    ...(extra.alternatives ? { alternatives: extra.alternatives } : {}),
  })
  await appendEntry($, note)
  return note
}

const runStandup = async ($: EngineInterface): Promise<string> => {
  const now = await $.clock.now()
  const drafts = await readDrafts($)
  const text = drafts[drafts.length - 1]?.markdown ?? (await standupText($))
  const isCopied = await copyText($, text)
  const record = await markStandupGiven($)
  return `${text}\n\n_${isCopied ? 'Copied to the clipboard. ' : ''}Archived as ${record.id} (${dayLabel(now)}); the next standup starts from now._`
}

const runCommand = async ($: EngineInterface, command: string, args: string): Promise<string> => {
  switch (command) {
    case 'arch':
      await openPane($)
      return 'Architecture pane opened.'
    case 'arch-map':
      await startMap($, args)
      return 'Mapping the architecture…'
    case 'arch-theme': {
      if (args.trim() === 'default') {
        await setDefaultTheme($)
        return 'Diagram style reset to the editorial default.'
      }
      if (args.trim()) {
        startBrand($, args)
        return `Extracting design tokens from ${args.trim()}…`
      }
      await update($, askAtom, () => 'brand')
      return 'Enter your website in the field above the prompt, or run /arch-theme <url>.'
    }
    case 'arch-export':
      return exportSvg($)
    case 'standup':
      return runStandup($)
    case 'notepad': {
      await openPopout($)
      const url = await liveNotepad($)
      return url ? 'Notepad opened in your browser.' : `Opened the read-only browser view: the notepad server did not start (${notepadError ?? 'Node was not found'}).`
    }
    case 'done': {
      if (!args.trim()) return 'Usage: /done <words from the todo or blocker>'
      const hit = await closeItem($, ['todo', 'blocker'], args)
      return hit ? `Done: ${hit.text}` : `No open todo or blocker matches "${args.trim()}".`
    }
    case 'n':
    case 'todo':
    case 'blocker':
    case 'decision': {
      const type = NOTE_COMMANDS[command] ?? 'note'
      if (!args.trim()) return `Usage: /${command} [@component] <text>`
      const note = await addNote($, type, args, 'you')
      return `Logged ${type}${note.component ? ` on ${note.component}` : ''}.`
    }
    default:
      return `arch-live: unknown command ${command}`
  }
}

// The turn being recorded: what was asked, what changed. Module state is fine
// here: a reload mid-turn only loses that turn's entry.
type TurnDraft = {
  ts: number
  request: string
  files: Map<string, JournalFile>
  components: Set<string>
  commands: number
  added: string[]
  removed: string[]
}
let turn: TurnDraft | undefined
let lastComponent: string | undefined

// In a folder of repos, a turn belongs to the repo its edits were in: the
// pane switches there and the turn is logged in that repo's journal.
const followWork = async ($: EngineInterface, done: TurnDraft) => {
  const cwd = await $.session.cwd()
  const root = await currentRoot($)
  if (done.files.size === 0) return
  const abs = [...done.files.values()].map(f => (f.path.startsWith('/') ? f.path : `${root}/${f.path}`))
  const counts = new Map<string, number>()
  for (const p of abs) {
    const rest = p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : ''
    const child = rest.includes('/') ? rest.split('/')[0] : ''
    if (child && !child.startsWith('.')) counts.set(child, (counts.get(child) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!top) return
  const next = `${cwd}/${top[0]}`
  if (next === root && !(await read($, rootGuessAtom))) return
  const graph = next === root ? await read($, graphAtom) : await loadGraph($, next).catch(() => null)
  await update($, rootAtom, () => next)
  await update($, rootGuessAtom, () => false)
  await update($, graphAtom, () => graph)
  const files = new Map<string, JournalFile>()
  const before = [...done.files.values()]
  abs.forEach((p, i) => {
    const rel = p.startsWith(`${next}/`) ? p.slice(next.length + 1) : p
    const f = before[i]
    if (f) files.set(rel, { ...f, path: rel })
  })
  done.files = files
  done.components = new Set([...files.keys()].map(r => componentFor(graph, r)).filter((c): c is string => !!c))
  await changeSession($, ({ endedAt: _ended, ...open }) => open).catch(() => undefined)
}

const recordFile = async ($: EngineInterface, absPath: string, created: boolean) => {
  if (!turn) return
  const project = await projectPath($)
  const rel = absPath.startsWith(`${project}/`) ? absPath.slice(project.length + 1) : absPath
  if (rel.endsWith(GRAPH_FILE) || rel.endsWith(POPOUT_FILE)) return
  const file = turn.files.get(rel) ?? { path: rel, created, edits: 0 }
  turn.files.set(rel, { ...file, edits: file.edits + 1 })
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  const component = componentFor(graph, rel)
  if (component) {
    const isNew = !turn.components.has(component)
    turn.components.add(component)
    lastComponent = component
    if (isNew) {
      await update($, activeAtom, () => [...(turn?.components ?? [])])
      await publishLive($).catch(() => undefined)
    }
  }
}

// Hands Claude the chosen day's state with the next prompt, once.
const carryForward = async ($: EngineInterface, offer: CarryOffer) => {
  await update($, pendingAtom, () => offer.context)
  await update($, askAtom, ask => (ask === 'carry' ? null : ask))
  await $.store.set(`carry:${projectKey(await projectPath($))}`, dateKey(await $.clock.now()))
  $.ui.toast(`arch-live: ${dayLabel(Date.parse(`${offer.date}T12:00:00`))} will ride along with your next prompt`)
}

const carryDay = async ($: EngineInterface, date: string) => {
  const days = await recentDays($)
  const graph = (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null
  const offer = carryOffer(days.filter(d => d.date <= date), dateKey(Date.parse(`${date}T12:00:00`) + DAY_MS), graph)
  if (offer) await carryForward($, offer)
  else $.ui.toast('arch-live: nothing logged that day to carry forward')
}

const closeById = async ($: EngineInterface, id: string) => {
  const now = await $.clock.now()
  await appendEntry($, { id: newId(now), ts: now, type: 'done', ref: id, by: 'you' })
}

export const register: Register = on => {
  on('session.end', async ($, e, next) => {
    const now = await $.clock.now()
    await changeSession($, s => ({ ...s, endedAt: now })).catch(() => undefined)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.tool.register({
      name: 'arch_update',
      description: `Add, update or remove components and connections in the live architecture diagram (saved to ${GRAPH_FILE} in the project). Nodes merge by id, edges by from+to. Read that file for the current state.`,
      inputSchema: UPDATE_SCHEMA,
    })
    await $.tool.register({
      name: 'arch_theme',
      description: "Save the person's diagram style: a palette of semantic color roles and three font families. Returns contrast warnings to fix.",
      inputSchema: THEME_SCHEMA,
    })
    await $.command.register({ name: 'arch', description: 'Show the live architecture diagram' })
    await $.command.register({ name: 'arch-map', description: "Ask Claude to map a project's architecture", argumentHint: '[folder]' })
    await $.command.register({ name: 'arch-theme', description: 'Set your diagram style from a website', argumentHint: '[url | default]' })
    await $.command.register({ name: 'arch-export', description: `Write the diagram to ${EXPORT_FILE}` })
    await $.command.register({ name: 'notepad', description: 'Open the live notepad in your browser', immediate: true })
    await $.command.register({ name: 'standup', description: 'Your standup brief since the last one, copied to the clipboard', immediate: true })
    await $.command.register({ name: 'n', description: 'Jot a note in today’s journal', argumentHint: '[@component] text', immediate: true })
    await $.command.register({ name: 'todo', description: 'Add a todo to the journal', argumentHint: '[@component] text', immediate: true })
    await $.command.register({ name: 'blocker', description: 'Log a blocker', argumentHint: '[@component] text', immediate: true })
    await $.command.register({ name: 'decision', description: 'Log a decision ("… because …")', argumentHint: '[@component] text', immediate: true })
    await $.command.register({ name: 'done', description: 'Close a todo or blocker', argumentHint: 'words from it', immediate: true })
    await $.tool.register({
      name: 'describe_files',
      description: "Save one-line summaries of a component's files for the person's notepad (shown in its file view).",
      inputSchema: {
        type: 'object',
        properties: {
          component: { type: 'string', description: 'The architecture node id.' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Project-relative file path.' },
                summary: { type: 'string', description: 'One plain sentence, under 15 words.' },
              },
              required: ['path', 'summary'],
            },
          },
        },
        required: ['component', 'files'],
      },
    })
    await $.tool.register({
      name: 'save_standup',
      description: "Save the standup notes you wrote for the person; they show on the notepad's Standup tab, ready to copy.",
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'The standup notes, in Markdown.' },
          scope: { type: 'string', description: 'What it covers, e.g. "all sessions".' },
        },
        required: ['markdown'],
      },
    })
    await $.tool.register({
      name: 'log_decision',
      description: 'Record a design decision in the person’s work journal: what was decided, why, and what else was considered.',
      inputSchema: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          why: { type: 'string' },
          alternatives: { type: 'string', description: 'What else was considered, briefly.' },
          component: LOG_SCHEMA_COMPONENT,
        },
        required: ['decision', 'why'],
      },
    })
    await $.tool.register({
      name: 'log_blocker',
      description: 'Record something that blocks progress in the person’s work journal, or mark one resolved.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, resolved: { type: 'boolean' }, component: LOG_SCHEMA_COMPONENT },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'log_todo',
      description: 'Add a remaining work item to the person’s work journal, or mark one done.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, done: { type: 'boolean' }, component: LOG_SCHEMA_COMPONENT },
        required: ['text'],
      },
    })

    const themeText = await $.fs.read(await homeThemePath($)).catch(() => undefined)
    const theme = themeText ? plain(normalizeTheme(parseJson(themeText))) : null
    const root = await findRoot($)
    const graph = await loadGraph($, root).catch(() => null)
    await update($, themeAtom, () => theme)
    await update($, rootAtom, () => root)
    await update($, rootGuessAtom, () => root !== e.cwd)
    await update($, graphAtom, () => graph)

    const isProject = (await Promise.all(PROJECT_MARKERS.map(m => $.fs.exists(m)))).some(Boolean)
    const isDismissed = (await $.store.get(`dismissed:${e.cwd}`)) === true
    // Open again (a resumed session included), so it can take boards.
    await changeSession($, ({ endedAt: _ended, ...open }) => open).catch(() => undefined)
    await refreshJournal($).catch(() => undefined)
    // A mapped project's notepad is up while a session is, so an open tab reconnects.
    boot($)
    if (graph) void ensureNotepad($).catch(() => undefined)
    // A session left open past midnight moves its Journal to the new day.
    let shownDay = dateKey(await $.clock.now())
    $.clock.every(60_000, () => {
      void (async () => {
        const day = dateKey(await $.clock.now())
        if (day === shownDay) return
        shownDay = day
        await refreshJournal($)
      })().catch(() => undefined)
    })
    const now = await $.clock.now()
    const days = await recentDays($).catch(() => [])
    const hasToday = days.some(d => d.date === dateKey(now) && d.entries.length > 0)
    const carriedToday = (await $.store.get(`carry:${projectKey(await projectPath($))}`)) === dateKey(now)
    const offer = hasToday || carriedToday ? null : carryOffer(days, dateKey(now), graph)
    await update($, carryAtom, () => (offer ? plain(offer) : null))
    const ask: ArchAsk = !theme ? 'theme' : offer ? 'carry' : !graph && isProject && !isDismissed ? 'map' : null
    await update($, askAtom, () => ask)

    if (graph) {
      void openPane($)
      void saveSnapshot($, graph).catch(() => undefined)
    }

    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, SECTION] }
  })

  on('tool.call', { tool: UPDATE_TOOL }, async ($, e) => {
    const args = e as unknown as UpdateArgs
    if (args.root !== undefined) {
      const root = await absRoot($, cleanRoot(args.root))
      await update($, rootGuessAtom, () => false)
      if (root !== (await currentRoot($))) {
        await update($, rootAtom, () => root)
        const existing = await loadGraph($, root).catch(() => null)
        await update($, graphAtom, () => existing)
      }
    }
    const root = await currentRoot($)
    const before = await read($, graphAtom)
    const { graph, problems } = applyUpdate(before, args, await $.clock.now())
    if (turn) {
      const had = new Set((before?.nodes ?? []).map(n => n.id))
      const has = new Set(graph.nodes.map(n => n.id))
      turn.added.push(...graph.nodes.filter(n => !had.has(n.id)).map(n => n.label))
      turn.removed.push(...(before?.nodes ?? []).filter(n => !has.has(n.id)).map(n => n.label))
    }
    void saveSnapshot($, graph, before).catch(() => undefined)
    await update($, graphAtom, () => graph)
    await update($, askAtom, ask => (ask === 'map' ? null : ask))
    await $.fs.write(inRoot(root, GRAPH_FILE), `${JSON.stringify(graph, null, 2)}\n`)
    await writePopout($, graph, await currentTheme($))
    await publishLive($).catch(() => undefined)
    void openPane($)
    const summary = `Diagram now has ${graph.nodes.length} components and ${graph.edges.length} connections (saved to ${inRoot(root, GRAPH_FILE)}).`
    return { result: problems.length ? `${summary}\nSkipped: ${problems.join('; ')}` : summary }
  })

  on('tool.call', { tool: THEME_TOOL }, async ($, e) => {
    const given = e as unknown as { fonts?: unknown }
    const theme = plain(normalizeTheme(given.fonts ? e : { ...e, fonts: (await read($, themeAtom))?.fonts ?? DEFAULT_THEME.fonts }))
    await $.fs.write(await homeThemePath($), `${JSON.stringify(theme, null, 2)}\n`)
    await update($, themeAtom, () => theme)
    const graph = await read($, graphAtom)
    await update($, askAtom, ask => (ask === 'theme' || ask === 'brand' ? null : ask))
    await writePopout($, graph, theme)
    await publishLive($).catch(() => undefined)
    void openPane($)
    const warnings = themeWarnings(theme)
    const saved = `Saved "${theme.name}" to ${await homeThemePath($)}.`
    return { result: warnings.length ? `${saved}\nFix and call again: ${warnings.join('; ')}` : saved }
  })

  // Hand edits to the graph file (by Claude or by the person) redraw the pane.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const existed = await $.fs.exists(e.file_path).catch(() => true)
    const ran = await next(e)
    await reloadAfter($, e.file_path)
    if (ran.deny === undefined && !ran.isError) await recordFile($, e.file_path, !existed)
    return ran
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await reloadAfter($, e.file_path)
    if (ran.deny === undefined && !ran.isError) await recordFile($, e.file_path, false)
    return ran
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (turn) turn.commands += 1
    return ran
  })

  // The journal: each main-thread turn becomes one entry when it completes.
  on('prompt.submit', async ($, e, next) => {
    boot($)
    const pending = await read($, pendingAtom)
    const isTyped = e.text.trim() !== '' && !e.text.trim().startsWith('/')
    const result = await next(pending && isTyped ? { ...e, context: [...(e.context ?? []), pending] } : e)
    if (pending && isTyped && result.drop === undefined) await update($, pendingAtom, () => null)
    if (result.drop === undefined && e.text.trim() && !e.text.trim().startsWith('/')) {
      const first = distill(e.text, { mode: 'request', max: 1 }).statements[0]?.text ?? e.text
      const name = first.replace(/\s+/g, ' ').trim().slice(0, 48)
      await changeSession($, s => (s.isNamed || s.name ? s : { ...s, name })).catch(() => undefined)
      turn = {
        ts: await $.clock.now(),
        request: e.text,
        files: new Map(),
        components: new Set(),
        commands: 0,
        added: [],
        removed: [],
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    boot($)
    const result = await next(e)
    const done = turn
    if (!e.agentId && done) {
      turn = undefined
      await followWork($, done).catch(() => undefined)
      await changeSession($, s => s).catch(() => undefined)
      await update($, activeAtom, () => [])
      await publishLive($).catch(() => undefined)
      const request = distill(done.request, { mode: 'request', max: 2 }).statements.map(s => s.text).join(' ')
      const summary = distill(e.answer, { mode: 'log', max: 3 }).statements.map(s => s.text)
      const isWorth = done.files.size > 0 || done.added.length > 0 || done.removed.length > 0 || summary.length > 0
      if (isWorth) {
        await appendEntry($, {
          id: newId(done.ts),
          ts: done.ts,
          type: 'turn',
          request: request || done.request.slice(0, 160),
          summary,
          files: [...done.files.values()],
          components: [...done.components],
          commands: done.commands,
          ...(done.added.length || done.removed.length ? { arch: { added: done.added, removed: done.removed } } : {}),
        }).catch(() => undefined)
      }
    }
    return result
  })

  on('tool.call', { tool: DESCRIBE_TOOL }, async ($, e) => {
    const args = e as unknown as { component?: string; files?: { path?: string; summary?: string }[] }
    const graph = await read($, graphAtom)
    const node = graph?.nodes.find(n => n.id === args.component)
    if (!graph || !node) return { result: `No component "${args.component}" on the map. Use an id from ${GRAPH_FILE}.` }
    const now = await $.clock.now()
    const given = (args.files ?? []).filter(f => f.path && f.summary)
    const files = { ...(node.files ?? {}) }
    for (const f of given) files[cleanRoot(f.path)] = { summary: String(f.summary).trim().slice(0, 160), at: now }
    const next: ArchGraph = plain({ ...graph, nodes: graph.nodes.map(n => (n.id === node.id ? { ...n, files } : n)) })
    await update($, graphAtom, () => next)
    await $.fs.write(inRoot(await currentRoot($), GRAPH_FILE), `${JSON.stringify(next, null, 2)}\n`)
    return { result: `Saved ${given.length} file summar${given.length === 1 ? 'y' : 'ies'} for ${node.label}.` }
  })

  on('tool.call', { tool: STANDUP_TOOL }, async ($, e) => {
    const args = e as unknown as { markdown?: string; scope?: string }
    const markdown = String(args.markdown ?? '').trim()
    if (!markdown) return { result: 'Nothing to save: pass the standup as markdown.' }
    const now = await $.clock.now()
    const saved: StandupDraft = { markdown: markdown.slice(0, 20_000), scope: String(args.scope ?? 'all sessions').slice(0, 120), at: now }
    const kept = (parseJson(await $.fs.read(await draftsFile($)).catch(() => '')) as { drafts?: StandupDraft[] } | undefined)?.drafts ?? []
    await $.fs.write(await draftsFile($), `${JSON.stringify(plain({ drafts: [...kept, saved].slice(-20) }), null, 2)}\n`)
    await refreshJournal($).catch(() => undefined)
    return { result: "Saved. It is on the notepad's Standup tab and in the pane's Standup tab." }
  })

  on('tool.call', { tool: DECISION_TOOL }, async ($, e) => {
    const args = e as unknown as { decision?: string; why?: string; alternatives?: string; component?: string }
    if (!args.decision) return { result: 'decision is required.' }
    await addNote($, 'decision', args.decision, 'claude', {
      why: args.why,
      alternatives: args.alternatives,
      component: args.component,
    })
    return { result: 'Logged the decision in the journal.' }
  })

  on('tool.call', { tool: BLOCKER_TOOL }, async ($, e) => {
    const args = e as unknown as { text?: string; resolved?: boolean; component?: string }
    if (!args.text) return { result: 'text is required.' }
    if (args.resolved) {
      const hit = await closeItem($, ['blocker'], args.text, 'claude')
      return { result: hit ? `Marked resolved: ${hit.text}` : 'No open blocker matched; nothing changed.' }
    }
    await addNote($, 'blocker', args.text, 'claude', { component: args.component })
    return { result: 'Logged the blocker in the journal.' }
  })

  on('tool.call', { tool: TODO_TOOL }, async ($, e) => {
    const args = e as unknown as { text?: string; done?: boolean; component?: string }
    if (!args.text) return { result: 'text is required.' }
    if (args.done) {
      const hit = await closeItem($, ['todo'], args.text, 'claude')
      return { result: hit ? `Marked done: ${hit.text}` : 'No open todo matched; nothing changed.' }
    }
    await addNote($, 'todo', args.text, 'claude', { component: args.component })
    return { result: 'Added the todo to the journal.' }
  })

  // One hook answers every command of this mod, so a failure comes back as
  // text instead of the run going unanswered.
  on('command.run', async ($, e, next) => {
    const name = e.command.replace(/^arch-live:/, '')
    if (!COMMANDS.includes(name)) return next(e)
    try {
      return { text: await runCommand($, name, e.args ?? '') }
    } catch (err) {
      return { text: `arch-live: /${name} failed: ${errorText(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    boot($)
    const graph = await read($, graphAtom)
    const theme = (await read($, themeAtom)) ?? DEFAULT_THEME
    const tab = await read($, tabAtom)
    const jday = await read($, jdayAtom)
    const active = await read($, activeAtom)
    const linked = (graph?.nodes ?? []).filter(n => n.path).sort((a, b) => a.order - b.order)

    if (e.surface === 'terminal') {
      const { Box, Markdown, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Markdown text={outline(graph)} />
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {linked.map(n => (
              <Button key={`open:${n.id}`} label={n.label} dimColor onPress={() => openInEditor($, n.path ?? '', n.line)} />
            ))}
          </Box>
        </Box>
      )
    }

    const { Box, Svg, Text, Button, Markdown } = $.ui.resolve(e)
    const tabs = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {TABS.map(([id, label]) => (
          <Button key={`tab-${id}`} label={label} variant={tab === id ? 'primary' : 'secondary'} onPress={() => update($, tabAtom, () => id)} />
        ))}
        <Button key="notepad" label="Open notepad ↗" onPress={() => openPopout($)} />
        <Button key="refresh" label="↻" dimColor onPress={() => refreshAll($).catch(err => $.ui.toast(`arch-live: ${errorText(err)}`))} />
      </Box>
    )

    if (tab === 'standup') {
      const brief = await standupText($)
      const drafts = await readDrafts($)
      const written = drafts[drafts.length - 1]
      const shown = written?.markdown ? written.markdown : brief
      const past = (await archivedStandups($)).slice(0, 3)
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="standup-write" label="✦ Write with Claude" variant="primary" onPress={() => askForStandup($, false)} />
            <Button
              key="standup-copy"
              label="Copy"
              onPress={async () => $.ui.toast((await copyText($, shown)) ? 'Standup copied' : 'arch-live: could not copy')}
            />
            <Button
              key="standup-given"
              label="Archive & start fresh"
              onPress={async () => {
                try {
                  const record = await markStandupGiven($)
                  await refreshJournal($)
                  $.ui.toast(`Archived (${dayLabel(record.at)} ${timeLabel(record.at)}); the next standup starts from now`)
                } catch (err) {
                  $.ui.toast(`arch-live: could not archive, so nothing was reset (${errorText(err)})`)
                }
              }}
            />
          </Box>
          {written?.markdown ? (
            <Text key="standup-written" dimColor>{`Written by Claude · ${written.scope ?? 'all sessions'} · ${dayLabel(written.at ?? 0)} ${timeLabel(written.at ?? 0)}`}</Text>
          ) : null}
          <Markdown text={shown} />
          {past.length ? <Text key="standup-past-title" dimColor>{'Past standups (all in the notepad\'s History)'}</Text> : null}
          {past.map(a => (
            <Button
              key={`standup-past-${a.id}`}
              label={`${dayLabel(a.at)} ${timeLabel(a.at)} · ${a.scope} · Copy`}
              dimColor
              onPress={async () => $.ui.toast((await copyText($, a.written ?? a.brief)) ? 'Past standup copied' : 'arch-live: could not copy')}
            />
          ))}
        </Box>
      )
    }

    if (tab === 'journal') {
      const now = await $.clock.now()
      const today = dateKey(now)
      const chosen = (await read($, jdateAtom)) || today
      const dates = await read($, jdatesAtom)
      const open = await read($, openAtom)
      const noteType = await read($, noteTypeAtom)
      const labels = labelsFrom(jday ? [jday] : [], graph)
      const nameOf = (date: string) => (date === today ? 'Today' : dayLabel(Date.parse(`${date}T12:00:00`)))
      const recent = dates.slice(0, 5)
      const older = dates.slice(5)
      let composer = <Text dimColor>Use /n, /todo, /blocker or /decision to add notes here.</Text>
      if (e.surface !== 'mobile') {
        const { Input, Select } = $.ui.resolve(e)
        composer = (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {NOTE_TYPES.map(([type, label]) => (
                <Button
                  key={`type-${type}`}
                  label={label}
                  variant={noteType === type ? 'primary' : 'secondary'}
                  onPress={() => update($, noteTypeAtom, () => type)}
                />
              ))}
            </Box>
            <Input
              key="journal-note"
              placeholder={NOTE_PLACEHOLDER[noteType] ?? 'Note…'}
              submitLabel="Add"
              onSubmit={async text => {
                if (!text.trim()) return
                await addNote($, noteType, text, 'you')
                await showDay($, dateKey(await $.clock.now()))
              }}
            />
            {older.length > 0 && (
              <Select
                key="journal-older"
                label="Older"
                options={older.map(d => ({ value: d, label: nameOf(d) }))}
                value={older.includes(chosen) ? chosen : undefined}
                onSelect={date => showDay($, date)}
              />
            )}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {composer}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {recent.map(date => (
              <Button
                key={`day-${date}`}
                label={nameOf(date)}
                variant={chosen === date ? 'primary' : 'secondary'}
                onPress={() => showDay($, date)}
              />
            ))}
          </Box>
          {open.length > 0 && <Text bold>Open</Text>}
          {open.slice(0, 10).map(item => (
            <Box key={`open-${item.id}`} flexDirection="row" gap={1}>
              <Button key={`done-${item.id}`} label="Done" plain dimColor onPress={() => closeById($, item.id)} />
              <Text>
                {item.type === 'blocker' ? '⛔ ' : '☐ '}
                {item.text}
              </Text>
            </Box>
          ))}
          <Text bold>{nameOf(chosen)}</Text>
          <Markdown text={jday ? dayMarkdown(jday, labels) : '_Loading…_'} />
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {chosen !== today && <Button key="carry-day" label="Carry this day forward" onPress={() => carryDay($, chosen)} />}
            <Button
              key="copy-day"
              label="Copy day"
              onPress={async () => $.ui.toast((await copyText($, jday ? dayMarkdown(jday, labels) : '')) ? 'Day copied' : 'arch-live: could not copy')}
            />
          </Box>
        </Box>
      )
    }

    // Sized to the pane: the layout is chosen to fill its width, and the
    // drawing is given that width (and its own height) so nothing letterboxes.
    const room = Math.max(280, e.props.bodyColumns * CELL_PX - 16)
    const overlay: Overlay = { marks: marksOf(jday), active }
    const drawing = renderSvg(graph, theme, room, overlay)
    const width = Math.round(Math.min(room, drawing.width * 1.5))
    const height = Math.round((width * drawing.height) / drawing.width)
    let marker = <Text dimColor>Mark a component from the notepad.</Text>
    if (e.surface !== 'mobile' && graph?.nodes.length) {
      const { Select } = $.ui.resolve(e)
      marker = (
        <Select
          key="mark-node"
          label="Mark"
          options={graph.nodes.map(n => ({ value: n.id, label: n.label }))}
          onSelect={async id => {
            await update($, markTargetAtom, () => id)
            await update($, askAtom, () => 'mark')
          }}
        />
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Svg source={drawing.svg} alt={drawing.alt} width={width} height={height} />
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {marker}
          <Button key="map" label={graph ? 'Re-map' : 'Map a project'} onPress={() => startMap($, '')} />
          <Button key="theme" label="Style…" onPress={() => update($, askAtom, () => 'brand')} />
          <Button
            key="export"
            label="Export SVG"
            onPress={async () => $.ui.toast(await exportSvg($).catch(err => `arch-live: ${errorText(err)}`))}
          />
        </Box>
        {linked.length > 0 && <Text dimColor>Jump to code</Text>}
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {linked.map(n => (
            <Button key={`open:${n.id}`} label={n.label} dimColor onPress={() => openInEditor($, n.path ?? '', n.line)} />
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ask = await read($, askAtom)
    if (!ask || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (ask === 'carry') {
      const offer = await read($, carryAtom)
      if (!offer) return next(e)
      const parts = [
        offer.open ? `${offer.open} open item${offer.open > 1 ? 's' : ''}` : '',
        offer.blockers ? `${offer.blockers} blocker${offer.blockers > 1 ? 's' : ''}` : '',
        offer.decisions ? `${offer.decisions} decision${offer.decisions > 1 ? 's' : ''}` : '',
      ].filter(Boolean)
      return (
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text dimColor>
            arch-live · {dayLabel(Date.parse(`${offer.date}T12:00:00`))}: {parts.length ? parts.join(', ') : 'work logged'}.
          </Text>
          <Button key="carry-yes" label="Carry forward" variant="primary" onPress={() => carryForward($, offer)} />
          <Button
            key="carry-view"
            label="View"
            onPress={async () => {
              await update($, tabAtom, () => 'journal')
              await showDay($, offer.date)
              await openPane($)
            }}
          />
          <Button
            key="carry-skip"
            label="Skip"
            onPress={async () => {
              await $.store.set(`carry:${projectKey(await projectPath($))}`, dateKey(await $.clock.now()))
              await update($, askAtom, () => null)
            }}
          />
        </Box>
      )
    }

    if (ask === 'mark') {
      if (e.surface === 'mobile') return next(e)
      const target = await read($, markTargetAtom)
      const graph = await read($, graphAtom)
      const name = graph?.nodes.find(n => n.id === target)?.label ?? target ?? 'component'
      const { Input } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Input
            key="mark-text"
            label={`Mark ${name}`}
            placeholder="why it matters (optional)"
            submitLabel="Mark"
            autoFocus
            onSubmit={async text => {
              await addNote($, 'mark', text.trim() || '·', 'you', { component: target ?? undefined })
              await update($, askAtom, () => null)
            }}
          />
          <Button key="mark-cancel" label="Cancel" onPress={() => update($, askAtom, () => null)} />
        </Box>
      )
    }

    if (ask === 'brand') {
      if (e.surface === 'mobile') return next(e)
      const { Input } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Input
            key="brand-url"
            label="Your website"
            placeholder="acme.com"
            submitLabel="Extract tokens"
            autoFocus
            onSubmit={url => startBrand($, url)}
          />
          <Button key="brand-cancel" label="Cancel" onPress={() => update($, askAtom, () => null)} />
        </Box>
      )
    }

    if (ask === 'theme') {
      return (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>arch-live · pick a diagram style:</Text>
          <Button key="theme-default" label="Editorial default" onPress={() => setDefaultTheme($).then(() => update($, askAtom, () => null))} />
          <Button key="theme-brand" label="Match my website…" variant="primary" onPress={() => update($, askAtom, () => 'brand')} />
          <Button key="theme-later" label="Later" onPress={() => update($, askAtom, () => null)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>arch-live · this repo has no architecture map yet.</Text>
        <Button key="map-now" label="Map it" variant="primary" onPress={() => startMap($, '')} />
        <Button
          key="map-never"
          label="Not for this repo"
          onPress={async () => {
            await $.store.set(`dismissed:${await $.session.cwd()}`, true)
            await update($, askAtom, () => null)
          }}
        />
      </Box>
    )
  })
}
