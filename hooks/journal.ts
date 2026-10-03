import type { ArchGraph, ArchSnapshot, CarryOffer, JournalDay, JournalDone, JournalEntry, JournalNote, JournalTurn } from '../types'

// The work journal: one JSON file per project per day, outside the repo
// (~/.claude/arch-live/logs/<project>/<YYYY-MM-DD>.json), so notes and
// blockers never land in a company repo by accident.

const pad = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const dateKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const timeLabel = (ms: number) => {
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

export const dayLabel = (ms: number) => {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

export const projectKey = (abs: string) => abs.replace(/[^a-zA-Z0-9]/g, '-')

export const newId = (ms: number) => `${ms.toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const emptyDay = (date: string, project: string): JournalDay => ({ version: 1, date, project, entries: [] })

export const snapshotOf = (graph: ArchGraph, ts?: number): ArchSnapshot => ({
  ...(ts !== undefined ? { ts } : {}),
  nodes: graph.nodes.map(n => ({ id: n.id, label: n.label, kind: n.kind })),
  edges: graph.edges.map(e => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
})

const clean = (p: string) => p.trim().replace(/^\.\/+/, '').replace(/\/+$/, '')
const isFile = (p: string) => /\.[a-z0-9]+$/i.test(p.split('/').pop() ?? '')
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')

// The component a project-relative file belongs to: the node owning the
// longest matching folder (its `owns`, else its path's folder).
export const componentFor = (graph: ArchGraph | null, rel: string): string | undefined => {
  let best: { id: string; length: number } | undefined
  for (const node of graph?.nodes ?? []) {
    const path = node.path ? clean(node.path) : ''
    // What a node owns outranks where another node merely starts, at equal depth.
    const prefixes: [string, number][] = [
      ...(node.owns ?? []).map(o => [clean(o), 0.5] as [string, number]),
      [path, 0],
      [path && isFile(path) ? dirOf(path) : path, 0],
    ]
    for (const [prefix, bonus] of prefixes) {
      if (!prefix) continue
      const isMatch = rel === prefix || rel.startsWith(`${prefix}/`)
      const length = prefix.length + bonus
      if (isMatch && (!best || length > best.length)) best = { id: node.id, length }
    }
  }
  return best?.id
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// "@orders-api retry is flaky" → component orders-api, text "retry is flaky".
export const resolveTag = (graph: ArchGraph | null, raw: string): { text: string; component?: string } => {
  const match = /(^|\s)@([\w.-]+)/.exec(raw)
  if (!match) return { text: raw.trim() }
  const tag = (match[2] ?? '').toLowerCase()
  const nodes = graph?.nodes ?? []
  const node =
    nodes.find(n => n.id.toLowerCase() === tag) ??
    nodes.find(n => slug(n.label) === tag) ??
    nodes.find(n => n.id.toLowerCase().startsWith(tag) || slug(n.label).startsWith(tag))
  const text = raw.replace(match[0], match[1] ?? '').replace(/\s{2,}/g, ' ').trim()
  return node ? { text, component: node.id } : { text: raw.trim() }
}

export const isTurn = (e: JournalEntry): e is JournalTurn => e.type === 'turn'
export const isNote = (e: JournalEntry): e is JournalNote => e.type !== 'turn' && e.type !== 'done'
const isDone = (e: JournalEntry): e is JournalDone => e.type === 'done'

// Lines the browser notepad appends (<date>.web.jsonl), one entry each.
export const parseWebLines = (text: string): JournalEntry[] =>
  text
    .split('\n')
    .map(line => {
      try {
        return JSON.parse(line) as JournalEntry
      } catch {
        return undefined
      }
    })
    .filter((e): e is JournalEntry => !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.ts === 'number')

// Applies every done event to the note it names and drops the events, across
// days (a todo from Monday closed on Wednesday is done on Monday's page too).
export const resolveDays = (days: JournalDay[]): JournalDay[] => {
  const closed = new Map<string, number>()
  for (const day of days) for (const e of day.entries) if (isDone(e)) closed.set(e.ref, e.ts)
  return days.map(day => ({
    ...day,
    entries: day.entries
      .filter(e => !isDone(e))
      .sort((a, b) => a.ts - b.ts)
      .map(e => (isNote(e) && closed.has(e.id) ? { ...e, done: true, doneAt: closed.get(e.id) } : e)),
  }))
}

export const openItems = (days: JournalDay[]): JournalNote[] =>
  days.flatMap(d => d.entries).filter(isNote).filter(n => (n.type === 'todo' || n.type === 'blocker') && !n.done)

export const labelsFrom = (days: JournalDay[], graph: ArchGraph | null) => {
  const labels = new Map<string, string>()
  for (const day of days) for (const n of day.snapshot?.nodes ?? []) labels.set(n.id, n.label)
  for (const n of graph?.nodes ?? []) labels.set(n.id, n.label)
  return labels
}

// What to hand Claude at the start of a day: the last working day's state, short.
export const carryOffer = (days: JournalDay[], today: string, graph: ArchGraph | null): CarryOffer | null => {
  const last = days.filter(d => d.date < today && d.entries.length > 0).pop()
  if (!last) return null
  const labels = labelsFrom(days, graph)
  const label = (id?: string) => (id ? ` (${labels.get(id) ?? id})` : '')
  const open = openItems(days)
  const blockers = open.filter(n => n.type === 'blocker')
  const todos = open.filter(n => n.type === 'todo')
  const decisions = last.entries.filter(isNote).filter(n => n.type === 'decision')
  const worked = [...new Set(last.entries.filter(isTurn).flatMap(t => t.components))].map(id => labels.get(id) ?? id)
  const done = last.entries.filter(isTurn).flatMap(t => t.summary.slice(0, 1)).slice(-6)
  const lines = [
    `Carried forward from my work journal for ${dayLabel(Date.parse(`${last.date}T12:00:00`))}:`,
    ...(worked.length ? [`Worked in: ${worked.join(', ')}.`] : []),
    ...(done.length ? ['Done:', ...done.map(d => `- ${d}`)] : []),
    ...(decisions.length ? ['Decisions:', ...decisions.map(d => `- ${d.text}${d.why ? ` (because ${d.why})` : ''}`)] : []),
    ...(blockers.length ? ['Open blockers:', ...blockers.map(b => `- ${b.text}${label(b.component)}`)] : []),
    ...(todos.length ? ['Open todos:', ...todos.slice(0, 10).map(t => `- ${t.text}${label(t.component)}`)] : []),
    'Use this as background; do not act on it unless I ask.',
  ]
  return { date: last.date, open: todos.length, blockers: blockers.length, decisions: decisions.length, context: lines.join('\n') }
}

const NOTE_ICON: Record<string, string> = { note: '✎', todo: '☐', blocker: '⛔', decision: '◆', mark: '◯' }

// One day as Markdown, newest last: what the Journal tab and exports show.
export const dayMarkdown = (day: JournalDay, labels: Map<string, string>): string => {
  const label = (id?: string) => (id ? (labels.get(id) ?? id) : '')
  if (day.entries.length === 0) return '_Nothing logged this day yet. Use /n, /todo, /blocker or /decision, or just work: each turn is logged._'
  const lines: string[] = []
  for (const e of day.entries) {
    if (isTurn(e)) {
      const where = e.components.map(label).join(', ')
      lines.push(`**${timeLabel(e.ts)}** ${e.request}${where ? ` · _${where}_` : ''}`)
      for (const s of e.summary) lines.push(`- ${s}`)
      if (e.files.length) lines.push(`- _${e.files.length} file${e.files.length > 1 ? 's' : ''}: ${e.files.slice(0, 4).map(f => `\`${f.path}\``).join(', ')}${e.files.length > 4 ? ' …' : ''}_`)
      if (e.arch?.added.length) lines.push(`- _Map: added ${e.arch.added.join(', ')}_`)
      if (e.arch?.removed.length) lines.push(`- _Map: removed ${e.arch.removed.join(', ')}_`)
      lines.push('')
    } else if (isNote(e)) {
      const icon = e.done ? '✓' : (NOTE_ICON[e.type] ?? '•')
      const text = e.done ? `~~${e.text}~~` : e.text
      const why = e.why ? ` — because ${e.why}` : ''
      const where = e.component ? ` · _${label(e.component)}_` : ''
      lines.push(`${icon} **${timeLabel(e.ts)}** ${text}${why}${where}${e.by === 'claude' ? ' _(Claude)_' : ''}`, '')
    }
  }
  return lines.join('\n').trimEnd()
}

export type StandupInput = {
  title: string
  since: number
  now: number
  /** Every loaded day, oldest first: the window, plus earlier days for open items and the baseline. */
  days: JournalDay[]
  graph: ArchGraph | null
  /** Session names by id; with two or more sessions in the window, Done is grouped by session. */
  sessions?: Record<string, string>
}

// The brief for a standup: done (by component), decisions, blockers, next,
// architecture changes and notes, all since `since`.
export const buildStandup = ({ title, since, now, days, graph, sessions = {} }: StandupInput): string => {
  const labels = labelsFrom(days, graph)
  const label = (id?: string) => (id ? (labels.get(id) ?? id) : 'General')

  const entries = days.flatMap(d => d.entries)
  const recent = entries.filter(e => e.ts >= since)
  const notes = entries.filter(isNote)

  // Done, by session and then component. Work from before sessions were
  // recorded, or from one session only, needs no session heading.
  const done = new Map<string, Map<string, string[]>>()
  const add = (session: string, component: string, line: string) => {
    const bySession = done.get(session) ?? new Map<string, string[]>()
    const list = bySession.get(component) ?? []
    if (!list.includes(line) && list.length < 5) list.push(line)
    bySession.set(component, list)
    done.set(session, bySession)
  }
  for (const turn of recent.filter(isTurn)) {
    if (turn.files.length === 0 && !turn.arch) continue
    const line = turn.summary[0] ?? turn.request
    if (!line) continue
    const files = turn.files.length ? ` _(${turn.files.length} file${turn.files.length > 1 ? 's' : ''})_` : ''
    const components = turn.components.length ? turn.components : ['']
    for (const c of components) add(turn.session ?? '', label(c || undefined), `${line}${files}`)
  }
  for (const todo of notes.filter(n => n.type === 'todo' && n.done && (n.doneAt ?? 0) >= since)) {
    add(todo.session ?? '', label(todo.component), `✓ ${todo.text}`)
  }
  const sessionName = (id: string) => (id ? (sessions[id] ?? 'Unnamed session') : 'Earlier work')
  const isGrouped = [...done.keys()].filter(Boolean).length > 1

  const lines = [`# Standup · ${title} · ${dayLabel(now)}`, `_Since ${dayLabel(since)}, ${timeLabel(since)}_`, '']
  const section = (heading: string, body: string[]) => {
    if (body.length) lines.push(`## ${heading}`, ...body, '')
  }

  const components = (byComponent: Map<string, string[]>) =>
    [...byComponent.entries()].flatMap(([component, items]) => [`**${component}**`, ...items.map(i => `- ${i}`)])
  section(
    'Done',
    isGrouped
      ? [...done.entries()].flatMap(([id, byComponent]) => [`### ${sessionName(id)}`, ...components(byComponent), ''])
      : [...done.values()].flatMap(components),
  )
  section(
    'Decisions',
    recent
      .filter(isNote)
      .filter(n => n.type === 'decision')
      .map(n => `- ${n.text}${n.why ? ` — because ${n.why}` : ''}${n.alternatives ? ` _(considered: ${n.alternatives})_` : ''}`),
  )
  section('Blockers', [
    ...notes.filter(n => n.type === 'blocker' && !n.done).map(n => `- ${n.text}${n.component ? ` _(${label(n.component)})_` : ''}`),
    ...notes
      .filter(n => n.type === 'blocker' && n.done && (n.doneAt ?? 0) >= since)
      .map(n => `- ~~${n.text}~~ resolved`),
  ])
  section(
    'Next',
    notes.filter(n => n.type === 'todo' && !n.done).map(n => `- ${n.text}${n.component ? ` _(${label(n.component)})_` : ''}`),
  )

  // Architecture: the map as it stood when the window opened, against now.
  const snapshots = days
    .flatMap(d => [d.opening, d.snapshot])
    .filter((s): s is ArchSnapshot => s !== undefined)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
  const baseline = snapshots.filter(s => (s.ts ?? 0) <= since).pop() ?? snapshots[0]
  if (baseline && graph) {
    const was = new Set(baseline.nodes.map(n => n.id))
    const is = new Set(graph.nodes.map(n => n.id))
    const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`
    const wasEdges = new Set(baseline.edges.map(edgeKey))
    const added = graph.nodes.filter(n => !was.has(n.id))
    const removed = baseline.nodes.filter(n => !is.has(n.id))
    const rewired = graph.edges.filter(e => !wasEdges.has(edgeKey(e)) && was.has(e.from) && was.has(e.to))
    section('Architecture', [
      ...(added.length ? [`- Added: ${added.map(n => `${n.label} (${n.kind})`).join(', ')}`] : []),
      ...(removed.length ? [`- Removed: ${removed.map(n => n.label).join(', ')}`] : []),
      ...(rewired.length ? [`- New connections: ${rewired.map(e => `${label(e.from)} → ${label(e.to)}`).join(', ')}`] : []),
    ])
  }

  section(
    'Notes',
    recent
      .filter(isNote)
      .filter(n => n.type === 'note' || n.type === 'mark')
      .map(n => `- ${timeLabel(n.ts)}${n.component ? ` **${label(n.component)}**` : ''} ${n.text}`),
  )

  if (lines.length <= 3) lines.push(`No logged work since ${dayLabel(since)}.`)
  return lines.join('\n').trimEnd()
}
