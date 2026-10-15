import type { ArchGraph, ArchSnapshot, CarryOffer, JournalCommit, JournalDay, JournalDone, JournalEdit, Insights, JournalEntry, JournalNote, JournalSession, JournalTests, JournalTurn } from '../types'

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
const NOTE_KINDS = new Set(['note', 'todo', 'blocker', 'decision', 'mark'])
export const isNote = (e: JournalEntry): e is JournalNote => NOTE_KINDS.has(e.type)
const isDone = (e: JournalEntry): e is JournalDone => e.type === 'done'
export const isCommit = (e: JournalEntry): e is JournalCommit => e.type === 'commit'

// Your commits from `git log --no-merges --relative --name-only
// --format=%x1e%H%x1f%ct%x1f%ae%x1f%s`, as journal entries. Someone else's
// commits (another author email) and commits that touch nothing in the
// project folder are left out.
export const commitsFromLog = (text: string, email?: string): JournalCommit[] =>
  text
    .split('\u001e')
    .map(block => {
      const [head = '', ...rest] = block.split('\n')
      const [sha = '', ct = '', author = '', ...subject] = head.split('\u001f')
      const files = rest.map(l => l.trim()).filter(Boolean)
      if (!/^[0-9a-f]{40}$/.test(sha) || !files.length) return undefined
      if (email && author.toLowerCase() !== email.toLowerCase()) return undefined
      return { id: `commit-${sha}`, ts: Number(ct) * 1000, type: 'commit' as const, sha, subject: subject.join('\u001f').trim(), files }
    })
    .filter((c): c is JournalCommit => !!c && Number.isFinite(c.ts))

const short = (sha: string) => sha.slice(0, 7)
const testsText = (t: JournalTests) => `${t.passed} passed${t.failed ? `, ${t.failed} failed` : ''}`

// Where a turn's files went: "shipped in abc1234", "not committed", or how
// many of them a commit has taken so far. Empty when that is not known.
export const shipText = (t: JournalTurn): string => {
  if (!t.files.length || !t.uncommitted) return ''
  if (!t.uncommitted.length) return t.shipped?.length ? `shipped in ${t.shipped.map(c => short(c.sha)).join(', ')}` : ''
  if (!t.shipped?.length) return 'not committed'
  return `${t.files.length - t.uncommitted.length} of ${t.files.length} files committed`
}

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

// Applies the events on notes across days (a todo from Monday closed on
// Wednesday is done on Monday's page too): the latest edit sets its text, a
// remove takes it out, and its latest done or undone says whether it is done.
// The done event that closed it stays on the day it happened, with what it
// closed, so finishing something shows in that day's journal.
// In a git project (`tracksCommits`), each turn also learns which later
// commits took its files, and which of its files none has taken yet.
export const resolveDays = (days: JournalDay[], { tracksCommits = false }: { tracksCommits?: boolean } = {}): JournalDay[] => {
  const all = days.flatMap(d => d.entries).sort((a, b) => a.ts - b.ts)
  const commits = all.filter(isCommit)
  const ship = (logged: JournalTurn): JournalTurn => {
    // A run of no tests at all is a misread summary, logged before testRun knew better.
    const { tests, ...rest } = logged
    const t: JournalTurn = tests && tests.passed + tests.failed === 0 ? rest : logged
    if (!tracksCommits || !t.files.length) return t
    const shipped = new Map<string, { sha: string; subject: string }>()
    const uncommitted: string[] = []
    for (const f of t.files) {
      const c = commits.find(x => x.ts >= t.ts && x.files.includes(f.path))
      if (c) shipped.set(c.sha, { sha: c.sha, subject: c.subject })
      else uncommitted.push(f.path)
    }
    return { ...t, shipped: [...shipped.values()], uncommitted }
  }
  const edits = new Map<string, JournalEdit>()
  const removed = new Set<string>()
  const status = new Map<string, { isDone: boolean; at: number }>()
  for (const e of all) {
    if (e.type === 'edit') edits.set(e.ref, e)
    else if (e.type === 'remove') removed.add(e.ref)
    else if (isDone(e)) status.set(e.ref, { isDone: true, at: e.ts })
    else if (e.type === 'undone') status.set(e.ref, { isDone: false, at: e.ts })
  }
  const apply = (n: JournalNote): JournalNote => {
    const edit = edits.get(n.id)
    const shut = status.get(n.id)
    const edited = edit ? { ...n, text: edit.text, ...(edit.why !== undefined ? { why: edit.why || undefined } : {}), editedAt: edit.ts } : n
    return shut?.isDone ? { ...edited, done: true, doneAt: shut.at } : edited
  }
  const notes = new Map<string, { note: JournalNote; date: string }>()
  for (const day of days) for (const e of day.entries) if (isNote(e)) notes.set(e.id, { note: apply(e), date: day.date })
  return days.map(day => ({
    ...day,
    entries: day.entries
      .filter(e => {
        if (e.type === 'edit' || e.type === 'undone' || e.type === 'remove') return false
        if (isNote(e)) return !removed.has(e.id)
        if (isDone(e)) return !removed.has(e.ref) && status.get(e.ref)?.isDone === true && status.get(e.ref)?.at === e.ts
        return true
      })
      .sort((a, b) => a.ts - b.ts)
      .map(e => {
        if (isTurn(e)) return ship(e)
        if (isNote(e)) return apply(e)
        if (isDone(e)) {
          const found = notes.get(e.ref)
          return found ? { ...e, refText: found.note.text, refType: found.note.type, refDate: found.date } : e
        }
        return e
      }),
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
      if (e.tests) lines.push(`- _Tests: ${testsText(e.tests)} (\`${e.tests.command}\`)_`)
      const ship = shipText(e)
      if (ship) lines.push(`- _${ship[0]?.toUpperCase()}${ship.slice(1)}_`)
      lines.push('')
    } else if (isCommit(e)) {
      lines.push(`⎇ **${timeLabel(e.ts)}** Committed \`${short(e.sha)}\` ${e.subject} _(${e.files.length} file${e.files.length > 1 ? 's' : ''})_`, '')
    } else if (isDone(e)) {
      const from = e.refDate && e.refDate !== day.date ? ` _(${e.refType ?? 'item'} from ${dayLabel(Date.parse(`${e.refDate}T12:00:00`))})_` : ''
      lines.push(`✓ **${timeLabel(e.ts)}** Done: ${e.refText ?? 'an item'}${from}`, '')
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

// Every turn and note in the window, one line each, for Claude to write the
// standup from: more than the brief keeps, so nothing is lost to summarising.
export const standupDetail = ({ since, days, sessions = {} }: { since: number; days: JournalDay[]; sessions?: Record<string, string> }): string => {
  const lines: string[] = []
  const entries = days.flatMap(d => d.entries).filter(e => e.ts >= since).sort((a, b) => a.ts - b.ts)
  for (const e of entries) {
    const where = e.session ? ` [${sessions[e.session] ?? 'session'}]` : ''
    const when = `${dayLabel(e.ts)} ${timeLabel(e.ts)}`
    if (isTurn(e)) {
      const did = e.summary.length ? ` → ${e.summary.join(' ')}` : ''
      const parts = e.components.length ? ` (components: ${e.components.join(', ')})` : ''
      const files = e.files.length ? ` (${e.files.length} file${e.files.length > 1 ? 's' : ''})` : ''
      const tests = e.tests ? ` (tests: ${testsText(e.tests)})` : ''
      const ship = shipText(e) ? ` (${shipText(e)})` : ''
      lines.push(`- ${when}${where} Asked: ${e.request}${did}${parts}${files}${tests}${ship}`)
    } else if (isCommit(e)) {
      lines.push(`- ${when} Committed ${short(e.sha)}: ${e.subject} (${e.files.length} file${e.files.length > 1 ? 's' : ''})`)
    } else if (isNote(e)) {
      lines.push(`- ${when}${where} ${e.type}${e.done ? ' (done)' : ''}: ${e.text}${e.why ? ` — because ${e.why}` : ''}`)
    } else if (isDone(e) && e.refText) {
      lines.push(`- ${when}${where} completed ${e.refType ?? 'item'}: ${e.refText}`)
    }
  }
  return lines.slice(-200).join('\n') || '(nothing logged)'
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
    const ship = shipText(turn)
    const files = turn.files.length ? ` _(${turn.files.length} file${turn.files.length > 1 ? 's' : ''}${ship ? `, ${ship}` : ''})_` : ''
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
  // What shipped: your commits in the window. What did not: files changed in
  // the window that no commit has taken yet.
  section(
    'Shipped',
    recent.filter(isCommit).map(c => `- \`${short(c.sha)}\` ${c.subject} _(${c.files.length} file${c.files.length > 1 ? 's' : ''})_`),
  )
  const pending = [...new Set(recent.filter(isTurn).flatMap(t => t.uncommitted ?? []))]
  section(
    'Not committed yet',
    pending.length ? [`- ${pending.length} file${pending.length > 1 ? 's' : ''}: ${pending.slice(0, 6).map(p => `\`${p}\``).join(', ')}${pending.length > 6 ? ' …' : ''}`] : [],
  )
  // Tests: the last run in the window, against the first when they differ.
  const runs = recent.filter(isTurn).flatMap(t => (t.tests ? [t.tests] : []))
  const lastRun = runs[runs.length - 1]
  const firstRun = runs[0]
  const moved = firstRun && lastRun && runs.length > 1 && (firstRun.passed !== lastRun.passed || firstRun.failed !== lastRun.failed)
  section('Tests', lastRun ? [`- ${lastRun.failed ? '⚠ ' : ''}${testsText(lastRun)} · \`${lastRun.command}\`${moved ? ` _(was ${testsText(firstRun)})_` : ''}`] : [])
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

// The last `span` days at a glance, for the notepad's Insights tab and the
// diagram's overlays: work and commits per day, each day's last test run,
// which components saw work and what of theirs is not committed, the files
// changed most, and how todos and blockers are going.
export const insightsOf = (days: JournalDay[], graph: ArchGraph | null, now: number, span = 28): Insights => {
  const today = new Date(now)
  const dates = Array.from({ length: span }, (_, i) => dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (span - 1 - i), 12).getTime()))
  const from = dates[0] ?? dateKey(now)
  const perDay = dates.map(date => ({ date, turns: 0, commits: 0, files: 0 }) as Insights['days'][number])
  const byDate = new Map(perDay.map(d => [d.date, d]))
  const entries = days.flatMap(d => d.entries).sort((a, b) => a.ts - b.ts)
  const turns = entries.filter(isTurn)
  const recentTurns = turns.filter(t => dateKey(t.ts) >= from)

  for (const e of entries) {
    const d = byDate.get(dateKey(e.ts))
    if (!d) continue
    if (isCommit(e)) d.commits += 1
    if (isTurn(e)) {
      d.turns += 1
      d.files += e.files.length
      if (e.tests) d.tests = { passed: e.tests.passed, failed: e.tests.failed }
    }
  }

  const components: Insights['components'] = {}
  const of = (id: string) => (components[id] ??= { turns: 0, lastAt: 0, uncommitted: [] })
  for (const t of recentTurns) {
    for (const c of t.components) {
      const one = of(c)
      one.turns += 1
      one.lastAt = Math.max(one.lastAt, t.ts)
      if (t.tests) one.tests = { ...t.tests, at: t.ts }
    }
  }
  // Not committed: every turn's files that no later commit took, whatever day.
  for (const t of turns) {
    for (const p of t.uncommitted ?? []) {
      const c = componentFor(graph, p) ?? t.components[0]
      if (c && !of(c).uncommitted.includes(p)) of(c).uncommitted.push(p)
    }
  }

  const files = new Map<string, { path: string; edits: number; turns: number }>()
  for (const t of recentTurns) {
    for (const f of t.files) {
      const one = files.get(f.path) ?? { path: f.path, edits: 0, turns: 0 }
      one.edits += f.edits
      one.turns += 1
      files.set(f.path, one)
    }
  }

  const items = entries.filter(isNote).filter(n => n.type === 'todo' || n.type === 'blocker')
  const open = items.filter(n => !n.done)
  const closed = items.filter(n => n.done && n.doneAt !== undefined && dateKey(n.doneAt) >= from)
  const avgCloseMs = closed.length ? closed.reduce((sum, n) => sum + ((n.doneAt ?? n.ts) - n.ts), 0) / closed.length : undefined

  return {
    span,
    days: perDay,
    components,
    files: [...files.values()].sort((a, b) => b.edits - a.edits || b.turns - a.turns).slice(0, 8),
    items: {
      open: open.length,
      closed: closed.length,
      ...(avgCloseMs !== undefined ? { avgCloseMs } : {}),
      oldest: open.slice(0, 3).map(n => ({ text: n.text, type: n.type, ts: n.ts })),
    },
  }
}

// Folding one project's journal folder into another's: for journals that were
// split by subfolder (logs/<project>-test/ beside logs/<project>/) before
// every folder resolved to its project root. Each step is safe to repeat:
// entries are matched by id, so a second run adds nothing.

// The project a journal folder was written for: of the paths its files name
// (each day's `project`, meta.json's), the one the folder is named after.
export const folderProject = (key: string, paths: (string | undefined)[]): string | undefined =>
  paths.find((p): p is string => typeof p === 'string' && p.startsWith('/') && projectKey(p) === key)

const earlier = (a?: ArchSnapshot, b?: ArchSnapshot) => (!a ? b : !b ? a : (b.ts ?? 0) < (a.ts ?? 0) ? b : a)
const later = (a?: ArchSnapshot, b?: ArchSnapshot) => (!a ? b : !b ? a : (b.ts ?? 0) > (a.ts ?? 0) ? b : a)

// One day from both folders: every entry once (the target's copy kept), in
// time order; the earlier opening map and the later latest one.
export const mergeDay = (target: JournalDay | undefined, source: JournalDay, project: string): JournalDay => {
  const base: JournalDay = target ?? { version: 1, date: source.date, project, entries: [] }
  const seen = new Set(base.entries.map(e => e.id))
  const entries = [...base.entries, ...source.entries.filter(e => !seen.has(e.id))].sort((a, b) => a.ts - b.ts)
  const opening = earlier(base.opening, source.opening)
  const snapshot = later(base.snapshot, source.snapshot)
  return { ...base, project, entries, ...(opening ? { opening } : {}), ...(snapshot ? { snapshot } : {}) }
}

// The notepad's appended lines: the source's lines the target does not have yet.
export const mergeWebLines = (target: string, source: string): string => {
  const seen = new Set(parseWebLines(target).map(e => e.id))
  const added = parseWebLines(source).filter(e => !seen.has(e.id))
  if (added.length === 0) return target
  const head = target && !target.endsWith('\n') ? `${target}\n` : target
  return `${head}${added.map(e => JSON.stringify(e)).join('\n')}\n`
}

// One session seen from both folders: the target's record, over the span of both.
export const mergeSession = (target: JournalSession | undefined, source: JournalSession): JournalSession => {
  if (!target) return source
  const isSourceName = source.isNamed && !target.isNamed
  const endedAt = target.endedAt !== undefined && source.endedAt !== undefined ? Math.max(target.endedAt, source.endedAt) : target.endedAt
  return {
    ...source,
    ...target,
    ...(isSourceName ? { name: source.name, isNamed: true } : {}),
    startedAt: Math.min(target.startedAt, source.startedAt),
    lastAt: Math.max(target.lastAt, source.lastAt),
    ...(endedAt !== undefined ? { endedAt } : {}),
  }
}
