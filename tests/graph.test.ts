import { describe, expect, test } from 'claude-code/testing'

import type { ArchGraph, JournalDay } from '../types'
import { applyUpdate, mapDiff, marksOf, mergeChange, normalizeGraph, recentEdits } from '../hooks/graph'

const graph = (): ArchGraph => ({
  version: 1,
  title: 'Shop',
  nodes: [
    { id: 'web', label: 'Web', kind: 'client', path: 'web/page.tsx', order: 0 },
    { id: 'api', label: 'API', kind: 'service', path: 'api/server.ts', owns: ['api'], order: 1, files: { 'api/server.ts': { summary: 'Starts the server.', at: 1 } } },
  ],
  edges: [{ from: 'web', to: 'api', label: 'REST', style: 'http' }],
  focus: [],
  updatedAt: 1,
})

describe('normalizeGraph', () => {
  test('is null for anything that is not a map', () => {
    expect(normalizeGraph(undefined)).toBeNull()
    expect(normalizeGraph({ title: 'x' } as never)).toBeNull()
  })

  test('repairs what it can: kinds, labels, order, bad edges, focus', () => {
    const g = normalizeGraph({
      nodes: [{ id: 'a', kind: 'spaceship' }, { label: 'no id' }, { id: 'b', label: 'B', kind: 'store', order: 7 }] as never,
      edges: [{ from: 'a', to: 'b' }, { from: 'a' }] as never,
      focus: ['a', 'b', 'c'],
    })
    expect(g!.nodes).toEqual([
      { id: 'a', kind: 'service', label: 'a', order: 0 },
      { id: 'b', label: 'B', kind: 'store', order: 7 },
    ])
    expect(g!.edges).toEqual([{ from: 'a', to: 'b' }])
    expect(g!.focus).toEqual(['a', 'b'])
    expect(g!.updatedAt).toBe(0)
  })
})

describe('applyUpdate', () => {
  test('starts a map from nothing', () => {
    const { graph: g, problems } = applyUpdate(null, { title: 'New', nodes: [{ id: 'a', label: 'A', kind: 'worker' }] }, 50)
    expect(problems).toEqual([])
    expect(g).toEqual({ version: 1, title: 'New', nodes: [{ id: 'a', label: 'A', kind: 'worker', order: 0 }], edges: [], focus: ['a'], updatedAt: 50 })
  })

  test('merges nodes by id and keeps what the update leaves out', () => {
    const { graph: g } = applyUpdate(graph(), { nodes: [{ id: 'api', sublabel: 'Node · :3000' }] }, 2)
    const api = g.nodes.find(n => n.id === 'api')!
    expect(api).toMatchObject({ label: 'API', kind: 'service', sublabel: 'Node · :3000', path: 'api/server.ts' })
    expect(api.files).toBeDefined()
  })

  test('new nodes go after the last one', () => {
    const { graph: g } = applyUpdate(graph(), { nodes: [{ id: 'db', label: 'DB', kind: 'store' }] }, 2)
    expect(g.nodes.find(n => n.id === 'db')!.order).toBe(2)
  })

  test('a re-map keeps file summaries and breakdowns of components that keep their id', () => {
    const { graph: g } = applyUpdate(graph(), { replace: true, nodes: [{ id: 'api', label: 'Orders API' }] }, 2)
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0]!.files).toEqual({ 'api/server.ts': { summary: 'Starts the server.', at: 1 } })
    expect(g.edges).toEqual([])
  })

  test('removing a node removes its edges', () => {
    const { graph: g } = applyUpdate(graph(), { remove_nodes: ['api'] }, 2)
    expect(g.nodes.map(n => n.id)).toEqual(['web'])
    expect(g.edges).toEqual([])
  })

  test('says what it skipped', () => {
    const { graph: g, problems } = applyUpdate(graph(), {
      nodes: [{ id: '' }, { id: 'q', kind: 'spaceship' as never }],
      edges: [{ from: 'web', to: 'nowhere' }],
    }, 2)
    expect(problems).toEqual([
      'a node without an id was skipped',
      'q: unknown kind "spaceship", kept as service',
      'edge web → nowhere names an unknown node and was skipped',
    ])
    expect(g.nodes.find(n => n.id === 'q')!.kind).toBe('service')
  })

  test('edges merge by their two ends; bad styles are dropped', () => {
    const { graph: g } = applyUpdate(graph(), { edges: [{ from: 'web', to: 'api', label: 'GraphQL', style: 'pigeon' as never }] }, 2)
    expect(g.edges).toEqual([{ from: 'web', to: 'api', label: 'GraphQL', style: 'http' }])
  })

  test('focus: given, else what the call touched when it touched 2 or fewer', () => {
    expect(applyUpdate(graph(), { nodes: [{ id: 'web' }] }, 2).graph.focus).toEqual(['web'])
    expect(applyUpdate(graph(), { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, 2).graph.focus).toEqual([])
    expect(applyUpdate(graph(), { focus: ['api', 'ghost'] }, 2).graph.focus).toEqual(['api'])
  })

  test('the result has no undefined anywhere, so it can go in plugin state', () => {
    const { graph: g } = applyUpdate(graph(), { nodes: [{ id: 'web', sublabel: '' }] }, 2)
    expect('sublabel' in g.nodes.find(n => n.id === 'web')!).toBe(false)
  })
})

describe('mapDiff and mergeChange', () => {
  test('there is no change without a map before', () => {
    expect(mapDiff(null, graph(), 5)).toBeNull()
  })

  test('the same map, reordered keys or order numbers, is no change', () => {
    const moved = graph()
    moved.nodes = moved.nodes.map(n => ({ ...n, order: n.order + 10 }))
    expect(mapDiff(graph(), moved, 5)).toBeNull()
  })

  test('says what was added, changed and removed, and how many links changed', () => {
    const after = applyUpdate(graph(), { nodes: [{ id: 'db', kind: 'store' }, { id: 'web', label: 'Web App' }], edges: [{ from: 'api', to: 'db' }], remove_nodes: [] }, 5).graph
    expect(mapDiff(graph(), after, 5)).toEqual({ at: 5, added: ['db'], changed: ['web'], removed: [], links: 1 })
    const gone = applyUpdate(graph(), { remove_nodes: ['api'] }, 6).graph
    expect(mapDiff(graph(), gone, 6)).toEqual({ at: 6, added: [], changed: [], removed: ['API'], links: 1 })
  })

  test('changes close together read as one; what was added stays new', () => {
    const first = { at: 0, added: ['db'], changed: [], removed: [], links: 1 }
    const second = { at: 60_000, added: [], changed: ['db', 'api'], removed: ['Old'], links: 2 }
    expect(mergeChange(first, second)).toEqual({ at: 60_000, added: ['db'], changed: ['api'], removed: ['Old'], links: 3 })
  })

  test('a change long after the last starts afresh', () => {
    const first = { at: 0, added: ['db'], changed: [], removed: [], links: 1 }
    const later = { at: 16 * 60_000, added: [], changed: ['api'], removed: [], links: 0 }
    expect(mergeChange(first, later)).toEqual(later)
    expect(mergeChange(null, later)).toEqual(later)
  })
})

describe('recentEdits and marksOf', () => {
  const day = (entries: JournalDay['entries']): JournalDay => ({ version: 1, date: '2026-10-04', project: '/p', entries })
  const now = 100 * 60_000

  test('counts edits by component over the last half hour, the running turn included', () => {
    const days = [
      day([
        { id: 'a', ts: now - 5 * 60_000, type: 'turn', request: '', summary: [], components: [], commands: 0, files: [{ path: 'api/routes.ts', created: false, edits: 2 }] },
        { id: 'b', ts: now - 45 * 60_000, type: 'turn', request: '', summary: [], components: [], commands: 0, files: [{ path: 'api/old.ts', created: false, edits: 9 }] },
      ]),
    ]
    const out = recentEdits(graph(), days, now, { ts: now - 1000, files: [{ path: 'api/routes.ts', created: false, edits: 1 }, { path: 'docs/x.md', created: true, edits: 1 }] })
    expect(out).toEqual({ api: { edits: 3, at: now - 1000, files: { 'api/routes.ts': 3 } } })
  })

  test("a component's latest open mark is drawn; cleared marks go", () => {
    const marks = marksOf([
      day([
        { id: '1', ts: 1, type: 'mark', text: 'slow', by: 'you', component: 'api' },
        { id: '2', ts: 2, type: 'mark', text: 'very slow', by: 'you', component: 'api' },
        { id: '3', ts: 3, type: 'mark', text: 'done with it', by: 'you', component: 'web', done: true },
        { id: '4', ts: 4, type: 'note', text: 'not a mark', by: 'you', component: 'web' },
      ]),
      null,
    ])
    expect(marks).toEqual({ api: 'very slow' })
  })
})
