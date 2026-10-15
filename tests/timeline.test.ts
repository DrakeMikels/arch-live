import { describe, expect, test } from 'claude-code/testing'

import type { ArchSnapshot, JournalDay, JournalTurn } from '../types'
import { diffSnapshots, isEmptyDiff, mapTimeline, snapshotGraph, stepCounts, stepKey } from '../hooks/timeline'

const snap = (ts: number, nodes: [string, string, ArchSnapshot['nodes'][number]['kind']?][], edges: [string, string, string?][] = []): ArchSnapshot => ({
  ts,
  nodes: nodes.map(([id, label, kind]) => ({ id, label, kind: kind ?? 'service' })),
  edges: edges.map(([from, to, label]) => ({ from, to, ...(label ? { label } : {}) })),
})

const day = (date: string, opening?: ArchSnapshot, snapshot?: ArchSnapshot, entries: JournalDay['entries'] = []): JournalDay => ({
  version: 1,
  date,
  project: '/p',
  entries,
  ...(opening ? { opening } : {}),
  ...(snapshot ? { snapshot } : {}),
})

const turn = (ts: number, request: string, arch?: JournalTurn['arch'], session?: string): JournalTurn => ({
  id: `t${ts}`,
  ts,
  type: 'turn',
  request,
  summary: [],
  files: [],
  components: [],
  commands: 0,
  ...(arch ? { arch } : {}),
  ...(session ? { session } : {}),
})

const base = snap(1, [['web', 'Web', 'client'], ['api', 'API']], [['web', 'api', 'REST']])

describe('diffSnapshots', () => {
  test('finds added, removed and renamed components', () => {
    const after = snap(2, [['web', 'Web App', 'client'], ['db', 'Postgres', 'store']], [])
    const d = diffSnapshots(base, after)
    expect(d.added).toEqual([{ id: 'db', label: 'Postgres', kind: 'store' }])
    expect(d.removed).toEqual([{ id: 'api', label: 'API', kind: 'service' }])
    expect(d.renamed).toEqual([{ id: 'web', from: 'Web', to: 'Web App' }])
  })

  test('finds connections made and gone, by their two ends', () => {
    const after = snap(2, [['web', 'Web', 'client'], ['api', 'API']], [['api', 'web']])
    const d = diffSnapshots(base, after)
    expect(d.linked).toEqual([{ from: 'api', to: 'web' }])
    expect(d.unlinked).toEqual([{ from: 'web', to: 'api', label: 'REST' }])
  })

  test('a relabelled connection is not a change of wiring', () => {
    const after = snap(2, [['web', 'Web', 'client'], ['api', 'API']], [['web', 'api', 'GraphQL']])
    expect(isEmptyDiff(diffSnapshots(base, after))).toBe(true)
  })

  test('the same map is no change', () => {
    expect(isEmptyDiff(diffSnapshots(base, { ...base, ts: 9 }))).toBe(true)
  })
})

describe('mapTimeline', () => {
  test('is empty without snapshots', () => {
    expect(mapTimeline([day('2026-10-01'), day('2026-10-02')])).toEqual([])
  })

  test('a day that changed nothing is left out', () => {
    expect(mapTimeline([day('2026-10-01', base, base)])).toEqual([])
  })

  test("a day's step is its opening map against its latest", () => {
    const later = snap(5, [['web', 'Web', 'client'], ['api', 'API'], ['jobs', 'Jobs', 'worker']], [['web', 'api', 'REST'], ['api', 'jobs']])
    const [step] = mapTimeline([day('2026-10-01', base, later)])
    expect(step).toMatchObject({ date: '2026-10-01', kind: 'day', from: 1, to: 5 })
    expect(step!.added.map(n => n.id)).toEqual(['jobs'])
    expect(step!.linked).toEqual([{ from: 'api', to: 'jobs' }])
    expect(step!.after).toEqual(later)
  })

  test('a change between two days shows as its own step, before the day', () => {
    const pulled = snap(10, [['web', 'Web', 'client'], ['api', 'API'], ['cache', 'Redis', 'store']], [['web', 'api', 'REST']])
    const steps = mapTimeline([day('2026-10-01', base, base), day('2026-10-02', pulled, pulled)])
    expect(steps.map(stepKey)).toEqual(['2026-10-02:between'])
    expect(steps[0]!.added.map(n => n.label)).toEqual(['Redis'])
    expect(steps[0]).toMatchObject({ from: 1, to: 10, turns: [] })
  })

  test('days are read in date order, whatever order they come in', () => {
    const two = snap(3, [['web', 'Web', 'client']])
    const steps = mapTimeline([day('2026-10-02', two, two), day('2026-10-01', base, base)])
    expect(steps.map(stepKey)).toEqual(['2026-10-02:between'])
    expect(steps[0]!.removed.map(n => n.id)).toEqual(['api'])
  })

  test('days without a snapshot are skipped, and the last map is kept across them', () => {
    const later = snap(9, [['web', 'Web', 'client']])
    const steps = mapTimeline([day('2026-10-01', base, base), day('2026-10-02'), day('2026-10-03', later, later)])
    expect(steps.map(stepKey)).toEqual(['2026-10-03:between'])
  })

  test('a day with only an opening or only a latest map uses it for both', () => {
    const later = snap(9, [['web', 'Web', 'client']])
    expect(mapTimeline([day('2026-10-01', base), day('2026-10-02', undefined, later)]).map(stepKey)).toEqual(['2026-10-02:between'])
  })

  test("the turns that changed the map ride along with the day's step, oldest first", () => {
    const later = snap(5, [['web', 'Web', 'client'], ['jobs', 'Jobs', 'worker']])
    const entries = [
      turn(4, 'Drop the API', { added: [], removed: ['API'] }, 's1'),
      turn(3, 'Add a job runner', { added: ['Jobs'], removed: [] }),
      turn(2, 'Fix a typo'),
      turn(1, 'Nothing on the map', { added: [], removed: [] }),
    ]
    const [step] = mapTimeline([day('2026-10-01', base, later, entries)])
    expect(step!.turns).toEqual([
      { ts: 3, request: 'Add a job runner', added: ['Jobs'], removed: [] },
      { ts: 4, request: 'Drop the API', session: 's1', added: [], removed: ['API'] },
    ])
  })

  test('a day whose turns changed the map and changed it back still shows them', () => {
    const entries = [turn(2, 'Try a queue', { added: ['Queue'], removed: [] }), turn(3, 'Undo the queue', { added: [], removed: ['Queue'] })]
    const [step] = mapTimeline([day('2026-10-01', base, base, entries)])
    expect(step!.kind).toBe('day')
    expect(isEmptyDiff(step!)).toBe(true)
    expect(step!.turns).toHaveLength(2)
  })
})

describe('snapshotGraph and stepCounts', () => {
  test('a snapshot draws as a map, in its own order', () => {
    const g = snapshotGraph(base, 'Shop')
    expect(g).toMatchObject({ version: 1, title: 'Shop', focus: [], updatedAt: 1 })
    expect(g.nodes.map(n => [n.id, n.order])).toEqual([['web', 0], ['api', 1]])
    expect(g.edges).toEqual([{ from: 'web', to: 'api', label: 'REST' }])
  })

  test('counts say what changed in a few words', () => {
    const d = diffSnapshots(base, snap(2, [['web', 'Web App', 'client'], ['db', 'DB', 'store']], [['web', 'db']]))
    expect(stepCounts(d)).toBe('1 added, 1 removed, 1 renamed, 2 connections')
    expect(stepCounts(diffSnapshots(base, base))).toBe('no change to the map itself')
  })
})
