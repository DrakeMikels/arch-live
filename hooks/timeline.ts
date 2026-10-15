import type { ArchGraph, ArchSnapshot, JournalDay, JournalTurn, TimelineLink, TimelineNode, TimelineStep } from '../types'

// The map's history, built from what the journal already keeps: each day's
// opening map (before its first change) and its latest. A day's own changes
// are its opening against its latest; what changed outside any session (a
// pull, an editor) shows as the gap between one day's latest and the next
// day's opening. No runtime imports, so the notepad server loads it as is.

type Diff = Pick<TimelineStep, 'added' | 'removed' | 'renamed' | 'linked' | 'unlinked'>

const linkKey = (l: TimelineLink) => `${l.from}>${l.to}`
const nodeOf = (n: TimelineNode): TimelineNode => ({ id: n.id, label: n.label, kind: n.kind })
const linkOf = (l: TimelineLink): TimelineLink => ({ from: l.from, to: l.to, ...(l.label ? { label: l.label } : {}) })

/** What changed from one map to another: components by id, connections by from and to. */
export const diffSnapshots = (before: ArchSnapshot, after: ArchSnapshot): Diff => {
  const was = new Map(before.nodes.map(n => [n.id, n]))
  const is = new Set(after.nodes.map(n => n.id))
  const hadLinks = new Set(before.edges.map(linkKey))
  const hasLinks = new Set(after.edges.map(linkKey))
  return {
    added: after.nodes.filter(n => !was.has(n.id)).map(nodeOf),
    removed: before.nodes.filter(n => !is.has(n.id)).map(nodeOf),
    renamed: after.nodes
      .filter(n => was.has(n.id) && was.get(n.id)!.label !== n.label)
      .map(n => ({ id: n.id, from: was.get(n.id)!.label, to: n.label })),
    linked: after.edges.filter(e => !hadLinks.has(linkKey(e))).map(linkOf),
    unlinked: before.edges.filter(e => !hasLinks.has(linkKey(e))).map(linkOf),
  }
}

export const isEmptyDiff = (d: Diff) =>
  d.added.length + d.removed.length + d.renamed.length + d.linked.length + d.unlinked.length === 0

const archTurns = (day: JournalDay): TimelineStep['turns'] =>
  day.entries
    .filter((e): e is JournalTurn => e.type === 'turn')
    .filter(t => !!t.arch && t.arch.added.length + t.arch.removed.length > 0)
    .sort((a, b) => a.ts - b.ts)
    .map(t => ({
      ts: t.ts,
      request: t.request,
      ...(t.session ? { session: t.session } : {}),
      added: t.arch?.added ?? [],
      removed: t.arch?.removed ?? [],
    }))

/** Every step that changed the map, oldest first. Days that changed nothing are left out. */
export const mapTimeline = (days: JournalDay[]): TimelineStep[] => {
  const steps: TimelineStep[] = []
  let last: ArchSnapshot | undefined
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const opening = day.opening ?? day.snapshot
    const latest = day.snapshot ?? day.opening
    if (!opening || !latest) continue
    if (last) {
      const gap = diffSnapshots(last, opening)
      if (!isEmptyDiff(gap)) {
        steps.push({ date: day.date, kind: 'between', from: last.ts ?? 0, to: opening.ts ?? 0, ...gap, turns: [], after: opening })
      }
    }
    const during = diffSnapshots(opening, latest)
    const turns = archTurns(day)
    if (!isEmptyDiff(during) || turns.length > 0) {
      steps.push({ date: day.date, kind: 'day', from: opening.ts ?? 0, to: latest.ts ?? 0, ...during, turns, after: latest })
    }
    last = latest
  }
  return steps
}

/** A step's key, unique in a timeline: its date and kind. */
export const stepKey = (step: Pick<TimelineStep, 'date' | 'kind'>) => `${step.date}:${step.kind}`

/** A snapshot as a map the renderer can draw. */
export const snapshotGraph = (snapshot: ArchSnapshot, title?: string): ArchGraph => ({
  version: 1,
  ...(title ? { title } : {}),
  nodes: snapshot.nodes.map((n, order) => ({ id: n.id, label: n.label, kind: n.kind, order })),
  edges: snapshot.edges.map(linkOf),
  focus: [],
  updatedAt: snapshot.ts ?? 0,
})

/** "2 added, 1 removed, 3 connections": a step in a few words. */
export const stepCounts = (step: Diff): string => {
  const links = step.linked.length + step.unlinked.length
  return [
    step.added.length ? `${step.added.length} added` : '',
    step.removed.length ? `${step.removed.length} removed` : '',
    step.renamed.length ? `${step.renamed.length} renamed` : '',
    links ? `${links} connection${links === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(', ') || 'no change to the map itself'
}
