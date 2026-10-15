import type { ArchEdge, ArchGraph, ArchNode, JournalDay, JournalFile, MapChange } from '../types'
import { FRESH_MS, KINDS, STYLES } from './constants'
import { componentFor, isNote } from './journal'
import { RECENT_MS } from './render'
import { canon, plain } from './util'

// The map's own logic, with no engine calls: reading the map file, merging an
// update into it, and saying what changed between two versions.

type NodeInput = Partial<Omit<ArchNode, 'order'>> & { id?: unknown }
export type UpdateArgs = {
  root?: string
  title?: string
  replace?: boolean
  nodes?: NodeInput[]
  edges?: Partial<ArchEdge>[]
  remove_nodes?: string[]
  remove_edges?: { from: string; to: string }[]
  focus?: string[]
}

/** The map file's contents as a map, repaired where it can be, or null when it is not one. */
export const normalizeGraph = (raw: Partial<ArchGraph> | undefined): ArchGraph | null => {
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

export const applyUpdate = (prev: ArchGraph | null, args: UpdateArgs, now: number) => {
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
      // A re-map keeps what was learned about a component that keeps its id.
      const was = prev?.nodes.find(n => n.id === id)
      const kept = { ...(was?.files ? { files: was.files } : {}), ...(was?.breakdown ? { breakdown: was.breakdown } : {}) }
      nodes.push({ id, label: input.label || id, kind: kind ?? 'service', order: order++, ...kept, ...patch })
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

// What changed between two versions of the map, or null when nothing did.
export const mapDiff = (before: ArchGraph | null, after: ArchGraph, at: number): MapChange | null => {
  if (!before) return null
  const old = new Map(before.nodes.map(n => [n.id, n]))
  const ids = new Set(after.nodes.map(n => n.id))
  const sig = (n: ArchNode) => canon({ ...n, order: 0 })
  const added = after.nodes.filter(n => !old.has(n.id)).map(n => n.id)
  const changed = after.nodes.filter(n => old.has(n.id) && sig(n) !== sig(old.get(n.id)!)).map(n => n.id)
  const removed = before.nodes.filter(n => !ids.has(n.id)).map(n => n.label)
  const key = (e: ArchEdge) => `${e.from}>${e.to}|${e.label ?? ''}|${e.style ?? ''}`
  const had = new Set(before.edges.map(key))
  const has = new Set(after.edges.map(key))
  const links = [...has].filter(k => !had.has(k)).length + [...had].filter(k => !has.has(k)).length
  return added.length || changed.length || removed.length || links ? { at, added, changed, removed, links } : null
}

// Changes close together read as one: what was added stays "new" while it
// is edited further.
export const mergeChange = (prev: MapChange | null, next: MapChange): MapChange => {
  if (!prev || next.at - prev.at > FRESH_MS) return next
  const added = [...new Set([...prev.added, ...next.added])]
  return {
    at: next.at,
    added,
    changed: [...new Set([...prev.changed, ...next.changed])].filter(id => !added.includes(id)),
    removed: [...new Set([...prev.removed, ...next.removed])],
    links: prev.links + next.links,
  }
}

export type RecentEdits = Record<string, { edits: number; at: number; files: Record<string, number> }>

// Edits by component over the last half hour: logged turns, plus the turn
// running now (its files, from `since`).
export const recentEdits = (
  graph: ArchGraph | null,
  days: JournalDay[],
  now: number,
  current?: { ts: number; files: Iterable<JournalFile> },
): RecentEdits => {
  const out: RecentEdits = {}
  const add = (path: string, edits: number, at: number) => {
    const id = componentFor(graph, path)
    if (!id) return
    const one = (out[id] ??= { edits: 0, at: 0, files: {} })
    one.edits += edits
    one.at = Math.max(one.at, at)
    one.files[path] = (one.files[path] ?? 0) + edits
  }
  for (const e of days.flatMap(d => d.entries)) {
    if (e.type !== 'turn' || now - e.ts > RECENT_MS) continue
    for (const f of e.files) add(f.path, f.edits, e.ts)
  }
  for (const f of current?.files ?? []) add(f.path, f.edits, current?.ts ?? now)
  return out
}

// Open marks (component → its latest open mark), drawn on the map. A mark
// stays until it is cleared, whatever day it was made.
export const marksOf = (days: (JournalDay | null)[]): Record<string, string> => {
  const marks: Record<string, string> = {}
  const entries = days.flatMap(d => d?.entries ?? []).sort((a, b) => a.ts - b.ts)
  for (const e of entries) if (isNote(e) && e.type === 'mark' && e.component && !e.done) marks[e.component] = e.text
  return marks
}
