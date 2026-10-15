import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArchAsk, ArchGraph, ArchNode, ArchPart, ArchTheme, CarryOffer, JournalDay, JournalEntry, JournalFile, JournalNote, JournalNoteType, JournalSession, JournalTests } from '../types'
import {
  BLOCKER_TOOL,
  BREAKDOWN_TOOL,
  CELL_PX,
  COMMANDS,
  DAY_MS,
  DECISION_TOOL,
  DESCRIBE_TOOL,
  EXPLAIN_TOOL,
  EXPORT_FILE,
  FRESH_MS,
  GRAPH_FILE,
  NOTE_COMMANDS,
  NOTE_PLACEHOLDER,
  NOTE_TYPES,
  PANE,
  PART_ROLES,
  POPOUT_FILE,
  PROJECT_MARKERS,
  STANDUP_TOOL,
  TABS,
  THEME_TOOL,
  TODO_TOOL,
  UPDATE_TOOL,
  VIEW_FILE,
} from './constants'
import { applyUpdate, mapDiff, marksOf, mergeChange, normalizeGraph, recentEdits } from './graph'
import type { UpdateArgs } from './graph'
import {
  buildStandup,
  carryOffer,
  componentFor,
  dateKey,
  dayLabel,
  dayMarkdown,
  emptyDay,
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
import { changeText, componentCard, fitText, stepMarkdown, stepTitle, timelineMarkdown } from './pane-text'
import { boardPrompt, brandPrompt, breakdownPrompt, describePrompt, explainPrompt, mapPrompt, SECTION, standupPrompt } from './prompts'
import { projectRootOf } from './project-root'
import { outline, popoutHtml, RECENT_MS, renderSvg } from './render'
import type { Overlay } from './render'
import { COMMAND_DEFS, TOOL_DEFS } from './schemas'
import { distill } from './ste'
import { testRun } from './test-runs'
import { DEFAULT_THEME, normalizeTheme, themeWarnings } from './theme'
import { mapTimeline, snapshotGraph, stepKey } from './timeline'
import { canon, cleanRoot, errorText, inRoot, parseJson, plain } from './util'

// arch-live: a live architecture diagram and a work journal for your standup.
//
// Everything that calls the engine ($) is in this file, in the sections below:
// the engine follows $ only into functions declared in the same file. What
// needs no engine lives beside it and is tested on its own: constants.ts,
// schemas.ts, prompts.ts, graph.ts (the map's logic), timeline.ts (its history), journal.ts, pane-text.ts, render.ts,
// theme.ts, ste.ts, project-root.ts and util.ts.

/* ---------- What the pane draws from, and the turn being recorded ---------- */

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
const tlStepAtom = atom({ plugin: 'arch-live', key: 'tlStep' } as const, '')
const openAtom = atom({ plugin: 'arch-live', key: 'open' } as const, [])
const activeAtom = atom({ plugin: 'arch-live', key: 'active' } as const, [])
const noteTypeAtom = atom({ plugin: 'arch-live', key: 'noteType' } as const, 'note')
const carryAtom = atom({ plugin: 'arch-live', key: 'carry' } as const, null)
const pendingAtom = atom({ plugin: 'arch-live', key: 'pending' } as const, null)
const markTargetAtom = atom({ plugin: 'arch-live', key: 'markTarget' } as const, null)
const notepadAtom = atom({ plugin: 'arch-live', key: 'notepad' } as const, null)
const mapAskedAtom = atom({ plugin: 'arch-live', key: 'mapAskedAt' } as const, null)
const mapOpenAtom = atom({ plugin: 'arch-live', key: 'mapOpen' } as const, [])
const mapSelAtom = atom({ plugin: 'arch-live', key: 'mapSel' } as const, null)
const mapChangeAtom = atom({ plugin: 'arch-live', key: 'mapChange' } as const, null)
const paneClockAtom = atom({ plugin: 'arch-live', key: 'paneClock' } as const, 0)

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
  tests?: JournalTests
}

const live: { turn: TurnDraft | undefined; lastComponent: string | undefined } = {
  turn: undefined,
  lastComponent: undefined,
}

/* ---------- Where things are: the project, its map and its journal ---------- */

// Where the project, its map and its journal are, and the map the pane shows.

const homeThemePath = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? '~'}/.claude/arch-live/theme.json`

// The project folder as a full path. A relative one would follow the session's
// folder, which moves whenever the shell changes directory.
const absRoot = async ($: EngineInterface, root: string) => {
  if (root.startsWith('/')) return root
  const cwd = await $.session.cwd()
  return root ? `${cwd}/${root}` : cwd
}

// The project a folder belongs to (the nearest folder up with a map, else the
// git root, else the folder): a session or a call pointed at test/ or public/
// still reaches the project's own map and journal, never a new empty one.
const rootOf = async ($: EngineInterface, abs: string) =>
  projectRootOf(abs, p => $.fs.exists(p), await $.env.get('HOME'))

// The stored root is resolved when it is set; before then, the session folder's project.
const currentRoot = async ($: EngineInterface) => {
  const stored = (await $.state.get({ plugin: 'arch-live', key: 'root' })).value ?? ''
  return stored ? absRoot($, stored) : rootOf($, await $.session.cwd())
}

// A root is a guess when it is not the session folder's own project: a map
// found one level down, in a folder of repos.
const isGuessFor = async ($: EngineInterface, root: string) => root !== (await rootOf($, await $.session.cwd()))

const projectPath = async ($: EngineInterface) => currentRoot($)

// Whose journal this session writes: its project, or, while the project is
// only a guess in a folder of repos, that folder's own journal, so work is
// never filed under a repo it did not touch.
const journalPath = async ($: EngineInterface) =>
  (await read($, rootGuessAtom)) ? rootOf($, await $.session.cwd()) : projectPath($)

const logsDir = async ($: EngineInterface) =>
  `${(await $.env.get('HOME')) ?? '~'}/.claude/arch-live/logs/${projectKey(await journalPath($))}`

const currentTheme = async ($: EngineInterface) =>
  (await $.state.get({ plugin: 'arch-live', key: 'theme' })).value ?? DEFAULT_THEME

const currentGraph = async ($: EngineInterface) => (await $.state.get({ plugin: 'arch-live', key: 'graph' })).value ?? null

const projectTitle = async ($: EngineInterface, graph: ArchGraph | null) =>
  graph?.title ?? (await projectPath($)).split('/').pop() ?? 'Project'

const loadGraph = async ($: EngineInterface, root: string): Promise<ArchGraph | null> => {
  const file = inRoot(root, GRAPH_FILE)
  if (!(await $.fs.exists(file))) return null
  return normalizeGraph(parseJson(await $.fs.read(file)) as Partial<ArchGraph> | undefined)
}

// The session folder's project when it has a map (found from a subfolder too),
// else the most recently updated map one level down (a folder of repos), else
// the folder's project (its git root, or the folder).
const findRoot = async ($: EngineInterface): Promise<string> => {
  const cwd = await $.session.cwd()
  const own = await rootOf($, cwd)
  if (await $.fs.exists(inRoot(own, GRAPH_FILE))) return own
  const entries = await $.fs.list().catch(() => [])
  let best = { root: '', mtime: -1 }
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    const file = `${entry.name}/${GRAPH_FILE}`
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (stat && stat.mtimeMs > best.mtime) best = { root: entry.name, mtime: stat.mtimeMs }
  }
  return best.root ? `${cwd}/${best.root}` : own
}

// Sets the map the pane draws and notes what changed, whoever changed it.
// A copy equal to the one shown changes nothing; `quiet` takes it without a note.
const setGraph = async ($: EngineInterface, next: ArchGraph, quiet = false) => {
  const before = await read($, graphAtom)
  if (before && canon(before) === canon(next)) return
  await update($, graphAtom, () => next)
  const change = quiet ? null : mapDiff(before, next, await $.clock.now())
  if (change) await update($, mapChangeAtom, prev => mergeChange(prev, change))
}

// A different project's map: nothing in it is "new" here.
const switchGraph = async ($: EngineInterface, graph: ArchGraph | null) => {
  await update($, graphAtom, () => graph)
  await update($, mapChangeAtom, () => null)
  await update($, mapSelAtom, () => null)
}

const writeGraph = async ($: EngineInterface, graph: ArchGraph) =>
  $.fs.write(inRoot(await currentRoot($), GRAPH_FILE), `${JSON.stringify(graph, null, 2)}\n`)

const readOpen = async ($: EngineInterface): Promise<string[]> => {
  const raw = parseJson(await $.fs.read(`${await logsDir($)}/${VIEW_FILE}`).catch(() => '')) as { open?: unknown } | undefined
  return Array.isArray(raw?.open) ? raw.open.filter((id): id is string => typeof id === 'string') : []
}

const saveOpen = async ($: EngineInterface, open: string[]) => {
  const list = [...new Set(open)]
  await update($, mapOpenAtom, () => list)
  await $.fs.write(`${await logsDir($)}/${VIEW_FILE}`, `${JSON.stringify({ open: list, updatedAt: await $.clock.now() }, null, 2)}\n`)
}

// A component pressed in the pane, as a click in the notepad: closed, it
// opens and its card shows; open, its card shows; showing, it closes.
const pressComponent = async ($: EngineInterface, id: string) => {
  const open = await read($, mapOpenAtom)
  const selected = await read($, mapSelAtom)
  if (!open.includes(id)) {
    await saveOpen($, [...open, id])
    await update($, mapSelAtom, () => id)
  } else if (selected !== id) {
    await update($, mapSelAtom, () => id)
  } else {
    await saveOpen($, open.filter(x => x !== id))
    await update($, mapSelAtom, () => null)
  }
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

// Hand edits to the map file (by Claude, the person, git) redraw the pane.
const reloadAfter = async ($: EngineInterface, filePath: string) => {
  if (!filePath.endsWith(GRAPH_FILE)) return
  const graph = await loadGraph($, await currentRoot($)).catch(() => null)
  if (graph) await setGraph($, graph)
  else await switchGraph($, null)
  await writePopout($, graph, await currentTheme($))
}

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

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Architecture' })

// A pane button's work, with any failure said in a toast instead of lost.
const act = ($: EngineInterface, what: string, work: () => Promise<unknown>) =>
  work().catch(err => $.ui.toast(`arch-live: ${what} did not work (${errorText(err)})`))

// A command or press cannot start a turn itself; queue the prompt just after.
const submitSoon = ($: EngineInterface, text: string) => {
  $.clock.after(50, () => {
    $.prompt.submit({ text }).catch(err => $.ui.toast(`arch-live: could not ask Claude (${errorText(err)})`))
  })
}

const copyText = async ($: EngineInterface, text: string) => {
  // The desktop app is a remote surface the engine cannot copy on; pbcopy can.
  const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) return true
  const ran = await $.process.run(['pbcopy'], { stdin: text }).catch(() => undefined)
  return ran?.exitCode === 0
}

/* ---------- The journal on disk ---------- */

// The work journal on disk (~/.claude/arch-live/logs/<project>/), what the
// notepad reads from it, and the Journal tab's view of it.

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

// Session names by id, for the standup and the timeline.
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
  // The notepad keeps git.json: whether the project is a git repo, so turns can say what is committed.
  const git = parseJson(await $.fs.read(`${await logsDir($)}/git.json`).catch(() => '')) as { repo?: boolean } | undefined
  return resolveDays(await Promise.all(dates.map(date => readDay($, date))), { tracksCommits: git?.repo === true })
}

const recentDays = async ($: EngineInterface) => loadDays($, dateKey((await $.clock.now()) - 60 * DAY_MS))

// What the notepad in the browser reads: the drawn map and the project's facts.
const publishLive = async ($: EngineInterface) => {
  const dir = await logsDir($)
  const graph = await currentGraph($)
  const theme = await currentTheme($)
  const now = await $.clock.now()
  const active = (await $.state.get({ plugin: 'arch-live', key: 'active' })).value ?? []
  const overlay: Overlay = { marks: marksOf(await recentDays($)), active, ids: true }
  await $.fs.write(`${dir}/live.svg`, renderSvg(graph, theme, undefined, overlay).svg)
  const meta = {
    project: await projectPath($),
    title: await projectTitle($, graph),
    nodes: (graph?.nodes ?? []).map(n => ({ id: n.id, label: n.label, kind: n.kind, path: n.path ?? null, line: n.line ?? null })),
    theme: { light: theme.light, dark: theme.dark, fonts: theme.fonts, mode: theme.mode, name: theme.name ?? null, source: theme.source ?? null },
    // For the notepad's map: today's marks and the components Claude is in now.
    marks: overlay.marks ?? {},
    active,
    updatedAt: now,
  }
  await $.fs.write(`${dir}/meta.json`, `${JSON.stringify(meta, null, 2)}\n`)
}

// Re-reads everything the pane draws from disk: the theme, which project's map
// to show, the map itself and the journal. For edits made outside this
// session (another session, your editor, git) that no hook saw.
const refreshAll = async ($: EngineInterface) => {
  const themeText = await $.fs.read(await homeThemePath($)).catch(() => undefined)
  const theme = themeText ? plain(normalizeTheme(parseJson(themeText))) : null
  const isGuess = await read($, rootGuessAtom)
  const kept = !isGuess && (await read($, rootAtom)) ? await rootOf($, await currentRoot($)) : undefined
  const root = kept ?? (await findRoot($))
  const graph = await loadGraph($, root).catch(() => null)
  const isSameRoot = root === (await currentRoot($))
  await update($, themeAtom, () => theme)
  await update($, rootAtom, () => root)
  const isGuessNow = !kept && (await isGuessFor($, root))
  if (!kept) await update($, rootGuessAtom, () => isGuessNow)
  if (graph && isSameRoot) await setGraph($, graph)
  else await switchGraph($, graph)
  await refreshJournal($).catch(() => undefined)
  await writePopout($, graph, theme ?? DEFAULT_THEME).catch(() => undefined)
  $.ui.toast(graph ? `arch-live: refreshed (${graph.nodes.length} components)` : 'arch-live: refreshed, no map found')
}

// Reloads what the Journal tab shows: the days there are, the chosen day, open items.
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

const closeById = async ($: EngineInterface, id: string) => {
  const now = await $.clock.now()
  await appendEntry($, { id: newId(now), ts: now, type: 'done', ref: id, by: 'you' })
}

const addNote = async ($: EngineInterface, type: JournalNoteType, raw: string, by: 'you' | 'claude', extra: Partial<JournalNote> = {}) => {
  const graph = await currentGraph($)
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
    component: extra.component ?? tagged.component ?? live.lastComponent,
    ...(why ? { why } : {}),
    ...(extra.alternatives ? { alternatives: extra.alternatives } : {}),
  })
  await appendEntry($, note)
  return note
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
  const graph = await currentGraph($)
  const offer = carryOffer(days.filter(d => d.date <= date), dateKey(Date.parse(`${date}T12:00:00`) + DAY_MS), graph)
  if (offer) await carryForward($, offer)
  else $.ui.toast('arch-live: nothing logged that day to carry forward')
}

// Saves a changed node into the map file and the pane.
const saveNode = async ($: EngineInterface, graph: ArchGraph, id: string, change: (n: ArchNode) => ArchNode) => {
  const next: ArchGraph = plain({ ...graph, nodes: graph.nodes.map(n => (n.id === id ? change(n) : n)) })
  await setGraph($, next)
  await writeGraph($, next)
  await publishLive($).catch(() => undefined)
}

/* ---------- Standups ---------- */

// The standup: its window (since the last one), Claude's write-ups, and the
// archive of standups given.

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

const standupFile = async ($: EngineInterface) => `${await logsDir($)}/standup.json`

const lastStandup = async ($: EngineInterface): Promise<number> => {
  const text = await $.fs.read(await standupFile($)).catch(() => undefined)
  const fromFile = text ? Number((parseJson(text) as { last?: number } | undefined)?.last ?? 0) : 0
  if (fromFile) return fromFile
  return Number((await $.store.get(`standup:${projectKey(await projectPath($))}`)) ?? 0)
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

// What save_standup keeps: one more write-up, the last 20 at most.
const saveDraft = async ($: EngineInterface, draft: StandupDraft) => {
  const kept = (parseJson(await $.fs.read(await draftsFile($)).catch(() => '')) as { drafts?: StandupDraft[] } | undefined)?.drafts ?? []
  await $.fs.write(await draftsFile($), `${JSON.stringify(plain({ drafts: [...kept, draft].slice(-20) }), null, 2)}\n`)
}

const archivedStandups = async ($: EngineInterface): Promise<StandupRecord[]> => {
  const dir = `${await logsDir($)}/standups`
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.name.endsWith('.json'))
  const all = await Promise.all(files.map(async f => parseJson(await $.fs.read(`${dir}/${f.name}`).catch(() => '')) as StandupRecord | undefined))
  return all.filter((a): a is StandupRecord => !!a?.id).sort((a, b) => b.at - a.at)
}

const standupSince = async ($: EngineInterface, now: number) => {
  const last = await lastStandup($)
  return last > now - 14 * DAY_MS ? last : now - DAY_MS
}

const standupText = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const since = await standupSince($, now)
  const graph = await currentGraph($)
  const title = await projectTitle($, graph)
  return buildStandup({ title, since, now, days: await recentDays($), graph, sessions: await sessionNames($) })
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
  const graph = await currentGraph($)
  const record: StandupRecord = {
    id,
    at: now,
    since,
    until: now,
    title: await projectTitle($, graph),
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

// One click: the window's journal goes to Claude, which writes the standup
// and saves it with save_standup.
// `session` limits it to one session; `names` are the names the notepad shows
// (the Claude app's titles), so the standup says what the sidebar says.
const askForStandup = async ($: EngineInterface, session: string | null, names?: Record<string, string>) => {
  const now = await $.clock.now()
  const since = await standupSince($, now)
  const all = await recentDays($)
  const days = session ? all.map(d => ({ ...d, entries: d.entries.filter(e => e.session === session) })) : all
  const sessions = { ...(await sessionNames($)), ...(names ?? {}) }
  const graph = await currentGraph($)
  const title = await projectTitle($, graph)
  const brief = buildStandup({ title, since, now, days, graph, sessions })
  const scope = session ? (sessions[session] ?? 'unnamed session') : 'all sessions'
  submitSoon($, standupPrompt(scope, since, brief, standupDetail({ since, days, sessions })))
  $.ui.toast('arch-live: asked Claude to write your standup; it starts when Claude is free')
}

const runStandup = async ($: EngineInterface): Promise<string> => {
  const now = await $.clock.now()
  const drafts = await readDrafts($)
  const text = drafts[drafts.length - 1]?.markdown ?? (await standupText($))
  const isCopied = await copyText($, text)
  const record = await markStandupGiven($)
  return `${text}\n\n_${isCopied ? 'Copied to the clipboard. ' : ''}Archived as ${record.id} (${dayLabel(now)}); the next standup starts from now._`
}

/* ---------- Mapping, styling and exporting ---------- */

// What a button, a command or the notepad can start: mapping, styling and
// exporting the diagram.

const startMap = async ($: EngineInterface, folder: string) => {
  const root = await rootOf($, folder.trim() ? await absRoot($, cleanRoot(folder)) : await currentRoot($))
  if (root !== (await currentRoot($))) await switchGraph($, await loadGraph($, root).catch(() => null))
  await update($, rootAtom, () => root)
  await update($, rootGuessAtom, () => false)
  await update($, askAtom, () => null)
  submitSoon($, mapPrompt(root))
  const askedAt = await $.clock.now()
  await update($, mapAskedAtom, () => askedAt)
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

const setDefaultTheme = async ($: EngineInterface) => {
  await $.fs.write(await homeThemePath($), `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`)
  await update($, themeAtom, () => DEFAULT_THEME)
  await writePopout($, await currentGraph($), DEFAULT_THEME)
}

const exportSvg = async ($: EngineInterface): Promise<string> => {
  const graph = await currentGraph($)
  if (!graph) return 'Nothing to export yet: run /arch-map first.'
  const root = await currentRoot($)
  await $.fs.write(inRoot(root, EXPORT_FILE), `${renderSvg(graph, await currentTheme($)).svg}\n`)
  return `Wrote ${inRoot(root, EXPORT_FILE)}. Embed it with ![Architecture](${EXPORT_FILE}).`
}

/* ---------- The browser notepad ---------- */

// The browser notepad: a small local server shipped with the mod, started once
// per session and stopped with it. Without Node it falls back to a static page.
let notepadStarting: Promise<string | undefined> | undefined
// Why the last start failed, so the fallback says what actually went wrong.
let notepadError: string | undefined

const notepadProblem = () => notepadError ?? 'Node was not found'

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
  | { kind: 'standup'; scope: 'all' | 'session'; session?: string; names?: Record<string, string> }
  | { kind: 'breakdown'; component: string }
  | { kind: 'map' }
  | { kind: 'brand'; url: string }
  | { kind: 'theme-default' }
  | { kind: 'explain'; component: string; part: string }

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
    // An older notepad sends scope "session" alone: this session.
    const one = request.session ?? (request.scope === 'session' ? await $.session.id() : null)
    await askForStandup($, one, request.names)
  } else if (request.kind === 'map') {
    await startMap($, '')
  } else if (request.kind === 'brand') {
    startBrand($, request.url)
  } else if (request.kind === 'theme-default') {
    await setDefaultTheme($)
    await publishLive($).catch(() => undefined)
    $.ui.toast('arch-live: diagram style reset to the editorial default')
  } else if (request.kind === 'breakdown' || request.kind === 'explain') {
    const graph = await read($, graphAtom)
    const node = graph?.nodes.find(n => n.id === request.component)
    if (!graph || !node) return $.ui.toast(`arch-live: no component "${request.component}" on the map`)
    if (request.kind === 'breakdown') {
      submitSoon($, breakdownPrompt(node, graph))
      $.ui.toast(`arch-live: asked Claude to break down ${node.label}`)
    } else {
      const part = node.breakdown?.parts.find(p => p.id === request.part)
      if (!part) return $.ui.toast('arch-live: that part is not in the breakdown any more')
      submitSoon($, explainPrompt(node, part))
      $.ui.toast(`arch-live: asked Claude to explain ${part.label}`)
    }
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
let mapSig = ''
let viewSig = ''
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
  // The map file, whoever saved it (another session, the notepad, your
  // editor, git): the pane redraws and tags what changed.
  const root = await currentRoot($)
  const mapStamp = await $.fs.stat(inRoot(root, GRAPH_FILE)).then(st => st.mtimeMs, () => 0)
  if (`${root}|${mapStamp}` !== mapSig) {
    const isSameRoot = mapSig.startsWith(`${root}|`)
    mapSig = `${root}|${mapStamp}`
    const graph = mapStamp ? await loadGraph($, root).catch(() => null) : null
    if (graph) await setGraph($, graph, !isSameRoot)
  }
  // Components opened or closed in the notepad open and close here too.
  const viewStamp = await $.fs.stat(`${dir}/${VIEW_FILE}`).then(st => st.mtimeMs, () => 0)
  if (`${dir}|${viewStamp}` !== viewSig) {
    viewSig = `${dir}|${viewStamp}`
    const open = await readOpen($)
    if (canon(open) !== canon(await read($, mapOpenAtom))) await update($, mapOpenAtom, () => open)
  }
  if (ticks % 30 === 0) {
    const now = await $.clock.now()
    await update($, paneClockAtom, () => now)
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
    await writePopout($, await currentGraph($), await currentTheme($), true)
    const file = await popoutFile($)
    const ran = await $.process.run(['open', file])
    if (ran.exitCode !== 0) $.ui.toast(`arch-live: could not open the browser view (${ran.stderr.trim() || ran.exitCode})`)
    else $.ui.toast(`arch-live: the notepad server did not start (${notepadProblem()}), so the browser view is read-only`)
  } catch (err) {
    $.ui.toast(`arch-live: ${errorText(err)}`)
  }
}

/* ---------- Claude's tools ---------- */

// The tools Claude calls to keep the map and the journal: how they are
// described to Claude, and what each one does.

const registerTools = async ($: EngineInterface) => {
  for (const tool of TOOL_DEFS) await $.tool.register(tool)
}

// A tool that failed (a full disk, a file it could not read) still answers,
// so Claude can say what went wrong instead of the call going unanswered.
const failed = (what: string, error: { kind: string; message?: string }) => ({
  result: `arch-live could not ${what}: ${error.kind === 'timeout' ? 'it took too long' : (error.message ?? 'an unknown error')}. Nothing else was changed.`,
})

const toolHooks = (on: Parameters<Register>[0]) => {
  on('tool.call', { tool: UPDATE_TOOL }, async ($, e) => {
    const args = e as unknown as UpdateArgs
    await update($, mapAskedAtom, () => null)
    let moved = ''
    if (args.root !== undefined) {
      const given = await absRoot($, cleanRoot(args.root))
      const root = await rootOf($, given)
      if (root !== given) moved = given
      await update($, rootGuessAtom, () => false)
      // A new root, or none stored yet: start from the map already there.
      if (root !== (await currentRoot($)) || !(await read($, rootAtom))) {
        await update($, rootAtom, () => root)
        const existing = await loadGraph($, root).catch(() => null)
        await switchGraph($, existing)
      }
    }
    const root = await currentRoot($)
    const before = await read($, graphAtom)
    const { graph, problems } = applyUpdate(before, args, await $.clock.now())
    const turn = live.turn
    if (turn) {
      const had = new Set((before?.nodes ?? []).map(n => n.id))
      const has = new Set(graph.nodes.map(n => n.id))
      turn.added.push(...graph.nodes.filter(n => !had.has(n.id)).map(n => n.label))
      turn.removed.push(...(before?.nodes ?? []).filter(n => !has.has(n.id)).map(n => n.label))
    }
    void saveSnapshot($, graph, before).catch(() => undefined)
    await setGraph($, graph)
    await update($, askAtom, ask => (ask === 'map' ? null : ask))
    await writeGraph($, graph)
    await writePopout($, graph, await currentTheme($))
    await publishLive($).catch(() => undefined)
    void openPane($)
    const summary = [
      `Diagram now has ${graph.nodes.length} components and ${graph.edges.length} connections (saved to ${inRoot(root, GRAPH_FILE)}).`,
      ...(moved ? [`${moved} is inside the project at ${root}, so this went to that project's map; give node paths relative to ${root}.`] : []),
    ].join('\n')
    return { result: problems.length ? `${summary}\nSkipped: ${problems.join('; ')}` : summary }
  }).catch(($, e, next) => failed('update the map', next.error))

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
  }).catch(($, e, next) => failed('save the style', next.error))

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
    await setGraph($, next)
    await writeGraph($, next)
    return { result: `Saved ${given.length} file summar${given.length === 1 ? 'y' : 'ies'} for ${node.label}.` }
  }).catch(($, e, next) => failed('save the file summaries', next.error))

  on('tool.call', { tool: BREAKDOWN_TOOL }, async ($, e) => {
    const args = e as unknown as { component?: string; parts?: Partial<ArchPart>[]; edges?: { from?: string; to?: string; label?: string }[] }
    const graph = await read($, graphAtom)
    const node = graph?.nodes.find(n => n.id === args.component)
    if (!graph || !node) return { result: `No component "${args.component}" on the map. Use an id from ${GRAPH_FILE}.` }
    const before = new Map((node.breakdown?.parts ?? []).map(p => [p.id, p]))
    const parts: ArchPart[] = (args.parts ?? [])
      .filter(p => typeof p.id === 'string' && p.id.trim() && typeof p.label === 'string')
      .slice(0, 14)
      .map(p => {
        const id = String(p.id).trim()
        const was = before.get(id)
        return {
          id,
          label: String(p.label).slice(0, 60),
          ...(p.role && PART_ROLES.includes(p.role) ? { role: p.role } : {}),
          ...(p.path ? { path: cleanRoot(p.path) } : {}),
          ...(typeof p.line === 'number' ? { line: p.line } : {}),
          ...(p.summary ? { summary: String(p.summary).slice(0, 200) } : {}),
          // An explanation stays with a part that keeps its id.
          ...(was?.detail ? { detail: was.detail, detailAt: was.detailAt } : {}),
        }
      })
    const ids = new Set([...parts.map(p => p.id), ...graph.nodes.map(n => n.id)])
    const edges = (args.edges ?? [])
      .filter(x => x.from && x.to && ids.has(x.from) && ids.has(x.to))
      .map(x => ({ from: String(x.from), to: String(x.to), ...(x.label ? { label: String(x.label).slice(0, 40) } : {}) }))
    const now = await $.clock.now()
    await saveNode($, graph, node.id, n => ({ ...n, breakdown: { parts, edges, at: now } }))
    return { result: `Saved ${parts.length} parts and ${edges.length} connections for ${node.label}; the notepad shows them when the component is opened.` }
  }).catch(($, e, next) => failed('save the breakdown', next.error))

  on('tool.call', { tool: EXPLAIN_TOOL }, async ($, e) => {
    const args = e as unknown as { component?: string; part?: string; detail?: string }
    const graph = await read($, graphAtom)
    const node = graph?.nodes.find(n => n.id === args.component)
    const part = node?.breakdown?.parts.find(p => p.id === args.part)
    if (!graph || !node || !part) return { result: `No part "${args.part}" in ${args.component}'s breakdown.` }
    const detail = String(args.detail ?? '').trim().slice(0, 6000)
    if (!detail) return { result: 'Nothing to save: pass the explanation as detail.' }
    const now = await $.clock.now()
    await saveNode($, graph, node.id, n => ({
      ...n,
      breakdown: n.breakdown ? { ...n.breakdown, parts: n.breakdown.parts.map(p => (p.id === part.id ? { ...p, detail, detailAt: now } : p)) } : n.breakdown,
    }))
    return { result: `Saved. It shows when ${part.label} is opened in the notepad.` }
  }).catch(($, e, next) => failed('save the explanation', next.error))

  on('tool.call', { tool: STANDUP_TOOL }, async ($, e) => {
    const args = e as unknown as { markdown?: string; scope?: string }
    const markdown = String(args.markdown ?? '').trim()
    if (!markdown) return { result: 'Nothing to save: pass the standup as markdown.' }
    const now = await $.clock.now()
    await saveDraft($, { markdown: markdown.slice(0, 20_000), scope: String(args.scope ?? 'all sessions').slice(0, 120), at: now })
    await refreshJournal($).catch(() => undefined)
    return { result: "Saved. It is on the notepad's Standup tab and in the pane's Standup tab." }
  }).catch(($, e, next) => failed('save the standup', next.error))

  on('tool.call', { tool: DECISION_TOOL }, async ($, e) => {
    const args = e as unknown as { decision?: string; why?: string; alternatives?: string; component?: string }
    if (!args.decision) return { result: 'decision is required.' }
    await addNote($, 'decision', args.decision, 'claude', {
      why: args.why,
      alternatives: args.alternatives,
      component: args.component,
    })
    return { result: 'Logged the decision in the journal.' }
  }).catch(($, e, next) => failed('log the decision', next.error))

  on('tool.call', { tool: BLOCKER_TOOL }, async ($, e) => {
    const args = e as unknown as { text?: string; resolved?: boolean; component?: string }
    if (!args.text) return { result: 'text is required.' }
    if (args.resolved) {
      const hit = await closeItem($, ['blocker'], args.text, 'claude')
      return { result: hit ? `Marked resolved: ${hit.text}` : 'No open blocker matched; nothing changed.' }
    }
    await addNote($, 'blocker', args.text, 'claude', { component: args.component })
    return { result: 'Logged the blocker in the journal.' }
  }).catch(($, e, next) => failed('log the blocker', next.error))

  on('tool.call', { tool: TODO_TOOL }, async ($, e) => {
    const args = e as unknown as { text?: string; done?: boolean; component?: string }
    if (!args.text) return { result: 'text is required.' }
    if (args.done) {
      const hit = await closeItem($, ['todo'], args.text, 'claude')
      return { result: hit ? `Marked done: ${hit.text}` : 'No open todo matched; nothing changed.' }
    }
    await addNote($, 'todo', args.text, 'claude', { component: args.component })
    return { result: 'Added the todo to the journal.' }
  }).catch(($, e, next) => failed('add the todo', next.error))
}

/* ---------- Recording turns ---------- */

// The journal's record of work: each main-thread turn becomes one entry when
// it completes, with the files and components its edits touched.

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
  const next = await rootOf($, `${cwd}/${top[0]}`)
  if (next === root && !(await read($, rootGuessAtom))) return
  const graph = next === root ? await read($, graphAtom) : await loadGraph($, next).catch(() => null)
  await update($, rootAtom, () => next)
  await update($, rootGuessAtom, () => false)
  if (next === root) await update($, graphAtom, () => graph)
  else await switchGraph($, graph)
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
  const turn = live.turn
  if (!turn) return
  const project = await projectPath($)
  const rel = absPath.startsWith(`${project}/`) ? absPath.slice(project.length + 1) : absPath
  if (rel.endsWith(GRAPH_FILE) || rel.endsWith(POPOUT_FILE)) return
  const file = turn.files.get(rel) ?? { path: rel, created, edits: 0 }
  turn.files.set(rel, { ...file, edits: file.edits + 1 })
  const component = componentFor(await currentGraph($), rel)
  if (component) {
    const isNew = !turn.components.has(component)
    turn.components.add(component)
    live.lastComponent = component
    if (isNew) {
      await update($, activeAtom, () => [...(live.turn?.components ?? [])])
      await publishLive($).catch(() => undefined)
    }
  }
}

const turnHooks = (on: Parameters<Register>[0]) => {
  // Hand edits to the graph file (by Claude or by the person) redraw the pane.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const file = typeof e.file_path === 'string' ? e.file_path : ''
    const existed = file ? await $.fs.exists(file).catch(() => true) : true
    const ran = await next(e)
    if (!file) return ran
    await reloadAfter($, file)
    if (ran.deny === undefined && !ran.isError) await recordFile($, file, !existed)
    return ran
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const file = typeof e.file_path === 'string' ? e.file_path : ''
    const ran = await next(e)
    if (!file) return ran
    await reloadAfter($, file)
    if (ran.deny === undefined && !ran.isError) await recordFile($, file, false)
    return ran
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (live.turn) live.turn.commands += 1
    // A test command's counts: the turn keeps its last run.
    if (live.turn && ran.deny === undefined && !ran.isError && ran.result && !ran.result.backgroundTaskId) {
      const run = testRun(String(e.command ?? ''), `${ran.result.stdout ?? ''}\n${ran.result.stderr ?? ''}`)
      if (run) live.turn.tests = run
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    boot($)
    const pending = await read($, pendingAtom)
    // A background task's notice arrives as a prompt too; it is not the person's request.
    const isNotice = e.text.trim().startsWith('<task-notification>')
    const isTyped = e.text.trim() !== '' && !e.text.trim().startsWith('/') && !isNotice
    const result = await next(pending && isTyped ? { ...e, context: [...(e.context ?? []), pending] } : e)
    if (pending && isTyped && result.drop === undefined) await update($, pendingAtom, () => null)
    if (result.drop === undefined && (isTyped || isNotice)) {
      if (isTyped) {
        const first = distill(e.text, { mode: 'request', max: 1 }).statements[0]?.text ?? e.text
        const name = first.replace(/\s+/g, ' ').trim().slice(0, 48)
        await changeSession($, s => (s.isNamed || s.name ? s : { ...s, name })).catch(() => undefined)
      }
      // A notice's turn still counts its edits, under a plain request.
      live.turn = {
        ts: await $.clock.now(),
        request: isNotice ? 'A background task finished.' : e.text,
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
    const done = live.turn
    if (!e.agentId && done) {
      live.turn = undefined
      await followWork($, done).catch(() => undefined)
      await changeSession($, s => s).catch(() => undefined)
      await update($, activeAtom, () => [])
      await publishLive($).catch(() => undefined)
      const request = distill(done.request, { mode: 'request', max: 2 }).statements.map(s => s.text).join(' ')
      const summary = distill(e.answer, { mode: 'log', max: 3 }).statements.map(s => s.text)
      const isWorth = done.files.size > 0 || done.added.length > 0 || done.removed.length > 0 || summary.length > 0 || !!done.tests
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
          ...(done.tests ? { tests: done.tests } : {}),
        }).catch(() => undefined)
      }
    }
    return result
  })
}

/* ---------- Slash commands ---------- */

// The mod's slash commands.

const registerCommands = async ($: EngineInterface) => {
  for (const command of COMMAND_DEFS) await $.command.register(command)
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
      return url ? 'Notepad opened in your browser.' : `Opened the read-only browser view: the notepad server did not start (${notepadProblem()}).`
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

const commandHooks = (on: Parameters<Register>[0]) => {
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
}

/* ---------- Session start and end ---------- */

// A session's start and end: the tools and commands, the project and map it
// shows, and the guide every prompt carries.

const sessionHooks = (on: Parameters<Register>[0]) => {
  on('session.end', async ($, e, next) => {
    const now = await $.clock.now()
    await changeSession($, s => ({ ...s, endedAt: now })).catch(() => undefined)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await registerTools($)
    await registerCommands($)

    const themeText = await $.fs.read(await homeThemePath($)).catch(() => undefined)
    const theme = themeText ? plain(normalizeTheme(parseJson(themeText))) : null
    // A project the session settled on (by working in it, or arch_update's
    // root) survives a reload or resume; only a guess is made again.
    const stored = (await read($, rootAtom)) && !(await read($, rootGuessAtom)) ? await currentRoot($) : ''
    const kept = stored && (await $.fs.exists(stored).catch(() => false)) ? await rootOf($, stored) : ''
    const root = kept || (await findRoot($))
    const graph = await loadGraph($, root).catch(() => null)
    await update($, themeAtom, () => theme)
    await update($, rootAtom, () => root)
    const isGuessNow = !kept && (await isGuessFor($, root))
    if (!kept) await update($, rootGuessAtom, () => isGuessNow)
    if (root === stored) await update($, graphAtom, () => graph)
    else await switchGraph($, graph)

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
}

/* ---------- The pane and the row above the prompt ---------- */

// The Architecture pane (Diagram, Journal, Timeline and Standup tabs) and the
// row above the prompt that offers to map, style or carry the journal forward.

// How far back the Timeline tab reads the journal.
const TIMELINE_DAYS = 180

const nameOfDate = (date: string, today: string) => (date === today ? 'Today' : dayLabel(Date.parse(`${date}T12:00:00`)))

const paneHooks = (on: Parameters<Register>[0]) => {
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
          <Markdown text={fitText(outline(graph))} />
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {linked.map(n => (
              <Button key={`open:${n.id}`} label={n.label} dimColor onPress={() => openInEditor($, n.path ?? '', n.line)} />
            ))}
          </Box>
        </Box>
      )
    }

    const { Box, Svg, Text, Button, Markdown } = $.ui.resolve(e)
    // Sized to the pane: the layout is chosen to fill its width, and the
    // drawing is given that width (and its own height) so nothing letterboxes.
    const room = Math.max(280, e.props.bodyColumns * CELL_PX - 16)
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
            <Button key="standup-write" label="✦ Write with Claude" variant="primary" onPress={() => askForStandup($, null)} />
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
          <Markdown text={fitText(shown)} />
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

    if (tab === 'timeline') {
      const now = await $.clock.now()
      const steps = mapTimeline(await loadDays($, dateKey(now - TIMELINE_DAYS * DAY_MS)))
      if (steps.length === 0) {
        return (
          <Box flexDirection="column" gap={1}>
            {tabs}
            <Markdown text={timelineMarkdown([])} />
          </Box>
        )
      }
      const chosen = await read($, tlStepAtom)
      const step = steps.find(s => stepKey(s) === chosen) ?? steps[steps.length - 1]!
      const newest = [...steps].reverse()
      const recent = newest.slice(0, 6)
      const older = newest.slice(6)
      const short = (s: (typeof steps)[number]) => `${nameOfDate(s.date, dateKey(now))}${s.kind === 'between' ? ' (outside)' : ''}`
      const drawing = renderSvg(snapshotGraph(step.after, graph?.title), theme, room, {
        fresh: { added: step.added.map(n => n.id), changed: step.renamed.map(r => r.id) },
      })
      const width = Math.round(Math.min(room, drawing.width * 1.5))
      const height = Math.round((width * drawing.height) / drawing.width)
      const text = stepMarkdown(step, await sessionNames($))
      let olderPicker = null
      if (older.length > 0 && e.surface !== 'mobile') {
        const { Select } = $.ui.resolve(e)
        olderPicker = (
          <Select
            key="tl-older"
            label="Older"
            options={older.map(s => ({ value: stepKey(s), label: short(s) }))}
            value={older.some(s => s === step) ? stepKey(step) : undefined}
            onSelect={key => update($, tlStepAtom, () => key)}
          />
        )
      }
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text key="tl-intro" dimColor>{`How the map changed: ${steps.length} step${steps.length === 1 ? '' : 's'} in the last ${TIMELINE_DAYS} days. The drawing shows the map after the step you choose.`}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {recent.map(s => (
              <Button
                key={`tl-${stepKey(s)}`}
                label={short(s)}
                variant={s === step ? 'primary' : 'secondary'}
                onPress={() => update($, tlStepAtom, () => stepKey(s))}
              />
            ))}
          </Box>
          {olderPicker}
          <Svg source={drawing.svg} alt={`The map after ${stepTitle(step)}. ${drawing.alt}`} width={width} height={height} />
          <Markdown text={fitText(text)} />
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button
              key="tl-copy"
              label="Copy this step"
              onPress={async () => $.ui.toast((await copyText($, text)) ? 'Step copied' : 'arch-live: could not copy')}
            />
            <Button
              key="tl-copy-all"
              label="Copy the timeline"
              onPress={async () => $.ui.toast((await copyText($, timelineMarkdown(steps))) ? 'Timeline copied' : 'arch-live: could not copy')}
            />
          </Box>
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
      const nameOf = (date: string) => nameOfDate(date, today)
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
          <Markdown text={jday ? fitText(dayMarkdown(jday, labels), 'end') : '_Loading…_'} />
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

    // Redrawn each minute as well as on every change, so what fades with time does.
    await read($, paneClockAtom)
    const now = await $.clock.now()
    const days = await recentDays($)
    const nodes = [...(graph?.nodes ?? [])].sort((a, b) => a.order - b.order)
    const open = (await read($, mapOpenAtom)).filter(id => nodes.some(n => n.id === id))
    const selectedId = await read($, mapSelAtom)
    const selected = nodes.find(n => n.id === selectedId)
    const change = await read($, mapChangeAtom)
    const fresh = change && now - change.at < FRESH_MS ? change : null
    const recent = recentEdits(graph, days, now, live.turn ? { ts: live.turn.ts, files: live.turn.files.values() } : undefined)
    const marks = marksOf(days)
    const overlay: Overlay = { marks, active, open, selected: selected?.id, fresh: fresh ?? undefined, recent, now }
    const drawing = renderSvg(graph, theme, room, overlay)
    // A Re-map request shows until the map is updated, or for half an hour.
    const askedAt = await read($, mapAskedAtom)
    const mapAskedAt = askedAt && now - askedAt < 30 * 60_000 ? askedAt : null
    const width = Math.round(Math.min(room, drawing.width * 1.5))
    const height = Math.round((width * drawing.height) / drawing.width)
    const name = (id: string) => nodes.find(n => n.id === id)?.label ?? id
    const savedAt = fresh?.at ?? graph?.updatedAt ?? 0
    const status = [
      `● Live · ${(await projectPath($)).split('/').pop() ?? ''}`,
      fresh ? `map changed at ${timeLabel(fresh.at)}: ${changeText(fresh, graph)}` : savedAt ? `map saved ${dateKey(savedAt) === dateKey(now) ? timeLabel(savedAt) : dayLabel(savedAt)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const isOpen = !!selected && open.includes(selected.id)
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Text key="map-status" dimColor>{status}</Text>
        {active.length ? <Text key="map-active" bold>{`Claude is working in ${active.map(name).join(', ')}`}</Text> : null}
        <Svg source={drawing.svg} alt={drawing.alt} width={width} height={height} />
        {mapAskedAt ? (
          <Text key="map-asked" dimColor>{`Re-map requested at ${timeLabel(mapAskedAt)} · Claude starts as soon as it is free, and the map redraws when it is done.`}</Text>
        ) : null}
        {nodes.length ? (
          <Box key="map-nodes" flexDirection="row" flexWrap="wrap" gap={1}>
            {nodes.map(n => (
              <Button
                key={`node:${n.id}`}
                label={`${open.includes(n.id) ? '▾' : '▸'} ${n.label}`}
                variant={selected?.id === n.id ? 'primary' : 'secondary'}
                onPress={() => act($, n.label, () => pressComponent($, n.id))}
              />
            ))}
            <Button key="map-open-all" label="Expand all" dimColor onPress={() => act($, 'Expand all', () => saveOpen($, nodes.map(n => n.id)))} />
            <Button key="map-close-all" label="Collapse all" dimColor onPress={() => act($, 'Collapse all', () => saveOpen($, []))} />
          </Box>
        ) : null}
        {selected && graph ? (
          <Box key="map-card" flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
            <Markdown
              text={fitText(componentCard(selected, graph, {
                isActive: active.includes(selected.id),
                edits: recent[selected.id] && now - recent[selected.id]!.at < RECENT_MS ? recent[selected.id] : undefined,
                tag: fresh?.added.includes(selected.id) ? 'NEW' : fresh?.changed.includes(selected.id) ? 'UPDATED' : '',
                mark: marks[selected.id],
                now,
              }))}
            />
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Button
                key="card-open"
                label={isOpen ? 'Close in the drawing' : 'Open in the drawing'}
                onPress={() => act($, 'Open', () => saveOpen($, isOpen ? open.filter(id => id !== selected.id) : [...open, selected.id]))}
              />
              {selected.path ? <Button key="card-code" label="Jump to code" onPress={() => openInEditor($, selected.path ?? '', selected.line)} /> : null}
              <Button
                key="card-breakdown"
                label={selected.breakdown ? 'Break down again' : 'Break down'}
                onPress={() => act($, 'Break down', () => handleAsk($, JSON.stringify({ kind: 'breakdown', component: selected.id })))}
              />
              <Button
                key="card-mark"
                label="Mark…"
                onPress={async () => {
                  await update($, markTargetAtom, () => selected.id)
                  await update($, askAtom, () => 'mark')
                }}
              />
              <Button key="card-close" label="✕" dimColor onPress={() => update($, mapSelAtom, () => null)} />
            </Box>
          </Box>
        ) : nodes.length ? (
          <Text key="map-hint" dimColor>Choose a component to open it in place and see its parts, connections and recent edits. For hover and dragging, use the notepad.</Text>
        ) : null}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="map" label={graph ? 'Re-map' : 'Map a project'} onPress={() => act($, 'Re-map', () => startMap($, ''))} />
          <Button key="theme" label="Style…" onPress={() => update($, askAtom, () => 'brand')} />
          <Button
            key="export"
            label="Export SVG"
            onPress={async () => $.ui.toast(await exportSvg($).catch(err => `arch-live: ${errorText(err)}`))}
          />
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
        <Button key="map-now" label="Map it" variant="primary" onPress={() => act($, 'Map it', () => startMap($, ''))} />
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

export const register: Register = on => {
  sessionHooks(on)
  toolHooks(on)
  turnHooks(on)
  commandHooks(on)
  paneHooks(on)
}
