import { describe, expect, test } from 'claude-code/testing'

import type { ArchGraph } from '../types'
import { cursorTurn, handoffPrompt, newDraft, plainTools } from '../hooks/cursor'

const graph: ArchGraph = {
  version: 1,
  title: 'Shop',
  nodes: [
    { id: 'api', label: 'Orders API', kind: 'service', path: 'apps/api/server.ts', owns: ['apps/api'], order: 0 },
    { id: 'db', label: 'Postgres', kind: 'store', order: 1 },
  ],
  edges: [{ from: 'api', to: 'db' }],
  focus: [],
  updatedAt: 0,
}

describe('cursorTurn', () => {
  test('builds the journal entry for a turn from what the hooks saw', () => {
    const draft = newDraft(1000, 'Add retries to the orders API when the database is busy.', graph)
    draft.files['apps/api/retry.ts'] = { path: 'apps/api/retry.ts', created: true, edits: 1 }
    draft.commands = 2
    draft.tests = { passed: 5, failed: 0, command: 'npm test' }
    draft.answer = 'I added a retry helper and used it in the orders API. All 5 tests pass.'
    const turn = cursorTurn(draft, graph, 't1', 'conv-1')
    expect(turn?.request).toBe('Add retries to the orders API when the database is busy.')
    expect(turn?.summary.length).toBeGreaterThan(0)
    expect(turn?.components).toEqual(['api'])
    expect(turn?.commands).toBe(2)
    expect(turn?.tests).toEqual({ passed: 5, failed: 0, command: 'npm test' })
    expect(turn?.session).toBe('conv-1')
    expect(turn?.arch).toBeUndefined()
  })

  test('notes what the turn added to or removed from the map', () => {
    const draft = newDraft(1000, 'Map it', graph)
    const after: ArchGraph = { ...graph, nodes: [graph.nodes[0] as ArchGraph['nodes'][number], { id: 'queue', label: 'Jobs queue', kind: 'queue', order: 2 }] }
    expect(cursorTurn(draft, after, 't2', 'c')?.arch).toEqual({ added: ['Jobs queue'], removed: ['Postgres'] })
  })

  test('a turn that did nothing worth a line is none', () => {
    expect(cursorTurn(newDraft(1000, 'hi', graph), graph, 't3', 'c')).toBeNull()
  })
})

describe('handoffPrompt', () => {
  const since = new Date('2026-10-14T09:00:00').getTime()

  test('names tools the way Cursor shows them', () => {
    expect(plainTools('call mcp__arch-live__arch_update now')).toBe('call arch_update now')
    const map = handoffPrompt({ kind: 'map' }, graph, '/p', since) ?? ''
    expect(map).toContain('arch_update')
    expect(map).not.toContain('mcp__')
  })

  test('a standup fetches the journal with a tool, so the prompt fits in a link', () => {
    const one = handoffPrompt({ kind: 'standup', scope: 'session', session: 'conv-1', names: { 'conv-1': 'Retries' } }, graph, '/p', since) ?? ''
    expect(one).toContain('(Retries, since')
    expect(one).toContain('call standup_brief with session "conv-1"')
    expect(one).toContain('save_standup')
    expect(one.length).toBeLessThan(2000)
  })

  test('breakdown and explain need a component that is on the map', () => {
    expect(handoffPrompt({ kind: 'breakdown', component: 'api' }, graph, '/p', since)).toContain('arch_breakdown')
    expect(handoffPrompt({ kind: 'breakdown', component: 'nope' }, graph, '/p', since)).toBeUndefined()
    expect(handoffPrompt({ kind: 'explain', component: 'api', part: 'x' }, graph, '/p', since)).toBeUndefined()
  })

  test('nothing to describe is nothing to ask', () => {
    expect(handoffPrompt({ kind: 'describe', component: 'api', label: 'Orders API', files: [] }, graph, '/p', since)).toBeUndefined()
  })

  test('a board points at its text file instead of pasting it', () => {
    const text = handoffPrompt({ kind: 'board', title: 'Plan', png: '/b/plan.png', mdFile: '/b/plan.md', note: 'Is this right?' }, graph, '/p', since) ?? ''
    expect(text).toContain('/b/plan.png')
    expect(text).toContain('/b/plan.md')
    expect(text).toContain('Is this right?')
  })
})
