// arch-live's MCP server for Cursor: the same tools the Claude Code mod gives
// Claude (arch_update, describe_files, log_decision, …), working on the same
// map and journal files, plus standup_brief, open_notepad and arch_export for
// what the mod does through its pane and commands. MCP over stdio: one
// JSON-RPC message per line in and out; anything else goes to stderr.

import '../../notepad/ts-register.mjs'

const core = await import('./core.mjs')
const { PART_ROLES, GRAPH_FILE } = await import('../../hooks/constants.ts')
const { applyUpdate } = await import('../../hooks/graph.ts')
const { buildStandup, standupDetail } = await import('../../hooks/journal.ts')
const { TOOL_DEFS } = await import('../../hooks/schemas.ts')
const { SECTION } = await import('../../hooks/prompts.ts')
const { plainTools } = await import('../../hooks/cursor.ts')
const { normalizeTheme, themeWarnings } = await import('../../hooks/theme.ts')
const { cleanRoot } = await import('../../hooks/util.ts')
const path = await import('node:path')
const readline = await import('node:readline')

const VERSION = '0.1.0'
const ROOT_ARG = { root: { type: 'string', description: 'The project folder. Omitted, the workspace you are working in.' } }

const BY_PERSON = { from_person: { type: 'boolean', description: 'True when the person asked for this entry themselves (their /n, /todo, /blocker or /decision command).' } }
const by = args => (args.from_person ? 'you' : 'claude')

const EXTRA_TOOLS = [
  {
    name: 'log_note',
    description: "Add the person's own note to their arch-live work journal (their /n command). Tag a component with @id in the text.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, component: { type: 'string', description: 'The architecture node id, when the note is about one.' }, ...ROOT_ARG }, required: ['text'] },
  },
  {
    name: 'standup_brief',
    description: "The person's arch-live journal since their last standup: the brief (done, decisions, blockers, next, what shipped, tests) and every turn and note, oldest first. Use it to write their standup, then save it with save_standup.",
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: 'Only this chat session (its id). Omitted, all sessions.' }, ...ROOT_ARG } },
  },
  {
    name: 'open_notepad',
    description: "Start the arch-live notepad (the journal, diagram, board, standup, timeline and insights in the browser) if it is not running, and return its address for the person to open.",
    inputSchema: { type: 'object', properties: { ...ROOT_ARG } },
  },
  {
    name: 'arch_export',
    description: 'Write the architecture diagram to docs/architecture.svg in the project, for a README.',
    inputSchema: { type: 'object', properties: { ...ROOT_ARG } },
  },
]

// The project a call is about: its root argument (a full path, or relative to
// the workspace), else the workspace the person is prompting in.
const projectFor = async root => {
  const base = await core.defaultRoot()
  if (!root) return { root: base }
  const given = path.isAbsolute(root) ? root : path.join(base, cleanRoot(root))
  const found = await core.projectOf(given)
  return { root: found, moved: found !== path.resolve(given) ? given : '' }
}
// The chat the person last prompted in, so notes land in its session.
const activeSession = () => core.readJson(path.join(core.BASE, 'cursor-active.json'), {}).session

const nodeOf = (graph, id) => graph?.nodes.find(n => n.id === id)
const saveNode = (root, logs, graph, id, change) => {
  core.writeGraph(root, { ...graph, nodes: graph.nodes.map(n => (n.id === id ? change(n) : n)) })
  core.publishLive(root, logs)
}

const TOOLS = {
  async arch_update(args) {
    const { root, moved } = await projectFor(args.root)
    const logs = core.logsDirOf(root)
    const before = core.readGraph(root)
    const { graph, problems } = applyUpdate(before, args, Date.now())
    core.saveSnapshot(logs, root, graph, before)
    core.writeGraph(root, graph)
    core.publishLive(root, logs)
    const summary = [
      `Diagram now has ${graph.nodes.length} components and ${graph.edges.length} connections (saved to ${path.join(root, GRAPH_FILE)}).`,
      ...(moved ? [`${moved} is inside the project at ${root}, so this went to that project's map; give node paths relative to ${root}.`] : []),
    ].join('\n')
    return problems.length ? `${summary}\nSkipped: ${problems.join('; ')}` : summary
  },

  async arch_theme(args) {
    const theme = normalizeTheme(args.fonts ? args : { ...args, fonts: core.readTheme().fonts })
    core.writeJson(core.THEME_FILE, theme)
    const { root } = await projectFor(undefined)
    core.publishLive(root, core.logsDirOf(root))
    const warnings = themeWarnings(theme)
    const saved = `Saved "${theme.name}" to ${core.THEME_FILE}.`
    return warnings.length ? `${saved}\nFix and call again: ${warnings.join('; ')}` : saved
  },

  async describe_files(args) {
    const { root } = await projectFor(args.root)
    const graph = core.readGraph(root)
    const node = nodeOf(graph, args.component)
    if (!node) return `No component "${args.component}" on the map. Use an id from ${GRAPH_FILE}.`
    const now = Date.now()
    const given = (args.files ?? []).filter(f => f?.path && f?.summary)
    const files = { ...(node.files ?? {}) }
    for (const f of given) files[cleanRoot(f.path)] = { summary: String(f.summary).trim().slice(0, 160), at: now }
    saveNode(root, core.logsDirOf(root), graph, node.id, n => ({ ...n, files }))
    return `Saved ${given.length} file summar${given.length === 1 ? 'y' : 'ies'} for ${node.label}.`
  },

  async arch_breakdown(args) {
    const { root } = await projectFor(args.root)
    const graph = core.readGraph(root)
    const node = nodeOf(graph, args.component)
    if (!node) return `No component "${args.component}" on the map. Use an id from ${GRAPH_FILE}.`
    const before = new Map((node.breakdown?.parts ?? []).map(p => [p.id, p]))
    const parts = (args.parts ?? [])
      .filter(p => typeof p?.id === 'string' && p.id.trim() && typeof p.label === 'string')
      .slice(0, 14)
      .map(p => {
        const id = String(p.id).trim()
        const was = before.get(id)
        return JSON.parse(JSON.stringify({
          id,
          label: String(p.label).slice(0, 60),
          role: p.role && PART_ROLES.includes(p.role) ? p.role : undefined,
          path: p.path ? cleanRoot(p.path) : undefined,
          line: typeof p.line === 'number' ? p.line : undefined,
          summary: p.summary ? String(p.summary).slice(0, 200) : undefined,
          // An explanation stays with a part that keeps its id.
          detail: was?.detail,
          detailAt: was?.detailAt,
        }))
      })
    const ids = new Set([...parts.map(p => p.id), ...graph.nodes.map(n => n.id)])
    const edges = (args.edges ?? [])
      .filter(x => x?.from && x?.to && ids.has(x.from) && ids.has(x.to))
      .map(x => ({ from: String(x.from), to: String(x.to), ...(x.label ? { label: String(x.label).slice(0, 40) } : {}) }))
    saveNode(root, core.logsDirOf(root), graph, node.id, n => ({ ...n, breakdown: { parts, edges, at: Date.now() } }))
    return `Saved ${parts.length} parts and ${edges.length} connections for ${node.label}; the notepad shows them when the component is opened.`
  },

  async explain_part(args) {
    const { root } = await projectFor(args.root)
    const graph = core.readGraph(root)
    const node = nodeOf(graph, args.component)
    const part = node?.breakdown?.parts.find(p => p.id === args.part)
    if (!node || !part) return `No part "${args.part}" in ${args.component}'s breakdown.`
    const detail = String(args.detail ?? '').trim().slice(0, 6000)
    if (!detail) return 'Nothing to save: pass the explanation as detail.'
    const now = Date.now()
    saveNode(root, core.logsDirOf(root), graph, node.id, n => ({
      ...n,
      breakdown: { ...n.breakdown, parts: n.breakdown.parts.map(p => (p.id === part.id ? { ...p, detail, detailAt: now } : p)) },
    }))
    return `Saved. It shows when ${part.label} is opened in the notepad.`
  },

  async save_standup(args) {
    const markdown = String(args.markdown ?? '').trim()
    if (!markdown) return 'Nothing to save: pass the standup as markdown.'
    const { root } = await projectFor(args.root)
    core.saveDraft(core.logsDirOf(root), { markdown: markdown.slice(0, 20_000), scope: String(args.scope ?? 'all sessions').slice(0, 120), at: Date.now() })
    return "Saved. It is on the notepad's Standup tab, ready to copy."
  },

  async log_note(args) {
    if (!args.text) return 'text is required.'
    const { root } = await projectFor(args.root)
    core.addNote(core.logsDirOf(root), root, 'note', args.text, 'you', { component: args.component, session: activeSession() })
    return 'Added the note to the journal.'
  },

  async log_decision(args) {
    if (!args.decision) return 'decision is required.'
    const { root } = await projectFor(args.root)
    core.addNote(core.logsDirOf(root), root, 'decision', args.decision, by(args), { why: args.why, alternatives: args.alternatives, component: args.component, session: activeSession() })
    return 'Logged the decision in the journal.'
  },

  async log_blocker(args) {
    if (!args.text) return 'text is required.'
    const { root } = await projectFor(args.root)
    const logs = core.logsDirOf(root)
    if (args.resolved) {
      const hit = core.closeItem(logs, root, ['blocker'], args.text, by(args))
      return hit ? `Marked resolved: ${hit.text}` : 'No open blocker matched; nothing changed.'
    }
    core.addNote(logs, root, 'blocker', args.text, by(args), { component: args.component, session: activeSession() })
    return 'Logged the blocker in the journal.'
  },

  async log_todo(args) {
    if (!args.text) return 'text is required.'
    const { root } = await projectFor(args.root)
    const logs = core.logsDirOf(root)
    if (args.done) {
      const hit = core.closeItem(logs, root, ['todo'], args.text, by(args))
      return hit ? `Marked done: ${hit.text}` : 'No open todo matched; nothing changed.'
    }
    core.addNote(logs, root, 'todo', args.text, by(args), { component: args.component, session: activeSession() })
    return 'Added the todo to the journal.'
  },

  async standup_brief(args) {
    const { root } = await projectFor(args.root)
    const logs = core.logsDirOf(root)
    const now = Date.now()
    const since = core.standupSince(logs, now)
    const all = core.recentDays(logs, root)
    const days = args.session ? all.map(d => ({ ...d, entries: d.entries.filter(e => e.session === args.session) })) : all
    const graph = core.readGraph(root)
    const sessions = core.sessionNames(logs)
    const brief = buildStandup({ title: graph?.title ?? path.basename(root), since, now, days, graph, sessions })
    return ['Journal brief:', '', brief, '', 'Every turn and note, oldest first:', '', standupDetail({ since, days, sessions })].join('\n')
  },

  async open_notepad(args) {
    const { root } = await projectFor(args.root)
    const url = await core.ensureNotepad(root, core.logsDirOf(root), activeSession())
    return url ? `The notepad is running. Give the person this address to open: ${url}` : 'The notepad did not start. It needs Node 22.18 or newer on this machine.'
  },

  async arch_export(args) {
    const { root } = await projectFor(args.root)
    return core.exportSvg(root)
  },
}

// Cursor shows tools without Claude Code's mcp__server__ prefix.
// Every tool takes the project's root; the journal ones also say whose entry it is.
const LIST = [...TOOL_DEFS, ...EXTRA_TOOLS].map(t => {
  const extra = { ...(t.inputSchema.properties?.root ? {} : ROOT_ARG), ...(['log_decision', 'log_blocker', 'log_todo'].includes(t.name) ? BY_PERSON : {}) }
  return { name: t.name, description: plainTools(t.description), inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...extra } } }
})

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

const handle = async msg => {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'arch-live', version: VERSION },
      instructions: plainTools(SECTION.text),
    })
  }
  if (method === 'tools/list') return reply(id, { tools: LIST })
  if (method === 'tools/call') {
    const run = TOOLS[params?.name]
    if (!run) return reply(id, { content: [{ type: 'text', text: `No tool "${params?.name}".` }], isError: true })
    try {
      const text = await run(params?.arguments ?? {})
      return reply(id, { content: [{ type: 'text', text }] })
    } catch (err) {
      process.stderr.write(`arch-live: ${params?.name} failed: ${err?.stack ?? err}\n`)
      return reply(id, { content: [{ type: 'text', text: `arch-live could not ${params?.name}: ${err?.message ?? err}. Nothing else was changed.` }], isError: true })
    }
  }
  if (method === 'ping') return reply(id, {})
  if (id !== undefined && id !== null) return fail(id, -32601, `Method not found: ${method}`)
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return fail(null, -32700, 'Parse error')
  }
  for (const one of Array.isArray(msg) ? msg : [msg]) handle(one).catch(err => process.stderr.write(`arch-live: ${err?.stack ?? err}\n`))
})
lines.on('close', () => process.exit(0))
