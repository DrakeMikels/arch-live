import { describe, expect, test } from 'claude-code/testing'

import type { ArchGraph, TimelineStep } from '../types'
import { changeText, componentCard, fitText, MARKDOWN_MAX, stepMarkdown, stepTitle, timelineMarkdown } from '../hooks/pane-text'

const graph: ArchGraph = {
  version: 1,
  nodes: [
    { id: 'web', label: 'Web', kind: 'client', order: 0 },
    { id: 'api', label: 'API', kind: 'service', sublabel: 'Node', path: 'api/server.ts', line: 12, order: 1, files: { 'api/a.ts': { summary: 's', at: 1 } } },
    { id: 'db', label: 'DB', kind: 'store', order: 2 },
  ],
  edges: [
    { from: 'web', to: 'api' },
    { from: 'api', to: 'db' },
  ],
  focus: [],
  updatedAt: 0,
}

describe('fitText', () => {
  test('short text is left alone', () => {
    expect(fitText('hello')).toBe('hello')
  })

  test('long text is cut at a line, under the pane’s limit, with a note', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const start = fitText(text)
    expect(start.length).toBeLessThan(10_000)
    expect(start).toStartWith('line 0\n')
    expect(start).toEndWith('Open notepad ↗)._')
    const end = fitText(text, 'end')
    expect(end.length).toBeLessThan(10_000)
    expect(end).toEndWith('line 1999')
    expect(MARKDOWN_MAX).toBeLessThan(10_000)
  })
})

describe('changeText and componentCard', () => {
  test('a change in a few words, by component name', () => {
    expect(changeText({ at: 0, added: ['db'], changed: ['api'], removed: ['Cron'], links: 1 }, graph)).toBe('1 new (DB), 1 updated, 1 removed (Cron), 1 link changed')
  })

  test('the card says what a component is, what it calls and what calls it', () => {
    const card = componentCard(graph.nodes[1]!, graph, { isActive: true, tag: 'NEW', now: 0 })
    expect(card).toContain('**API** · service · Node')
    expect(card).toContain('`api/server.ts:12`')
    expect(card).toContain('Claude is working here now · new in the latest map update')
    expect(card).toContain('Calls DB')
    expect(card).toContain('Called by Web')
    expect(card).toContain('Not broken down yet')
    expect(card).toContain('1 file described')
  })
})

describe('the timeline in the pane', () => {
  const step: TimelineStep = {
    date: '2026-10-02',
    kind: 'day',
    from: 1,
    to: 2,
    added: [{ id: 'db', label: 'DB', kind: 'store' }],
    removed: [{ id: 'cron', label: 'Cron', kind: 'worker' }],
    renamed: [{ id: 'api', from: 'Server', to: 'API' }],
    linked: [{ from: 'api', to: 'db', label: 'SQL' }],
    unlinked: [{ from: 'cron', to: 'api' }],
    turns: [{ ts: new Date('2026-10-02T09:05:00').getTime(), request: 'Add a database', session: 's1', added: ['DB'], removed: [] }],
    after: { nodes: graph.nodes.map(n => ({ id: n.id, label: n.label, kind: n.kind })), edges: graph.edges },
  }

  test('a step lists its changes by name, removed components included', () => {
    const text = stepMarkdown(step, { s1: 'Database work' })
    expect(text).toStartWith('**Fri 2 Oct** · 1 added, 1 removed, 1 renamed, 2 connections')
    expect(text).toContain('- **Added** DB (store)')
    expect(text).toContain('- **Removed** Cron')
    expect(text).toContain('- **Renamed** Server → API')
    expect(text).toContain('- **New connections** API → DB _(SQL)_')
    expect(text).toContain('- **Connections gone** Cron → API')
    expect(text).toContain('\n\n**What did it**\n- 9:05 AM Add a database _[Database work]_ · added DB')
  })

  test('a change between days says it happened outside a session', () => {
    const between = { ...step, kind: 'between' as const, turns: [] }
    expect(stepTitle(between)).toBe('Fri 2 Oct · before the first session')
    expect(stepMarkdown(between)).toContain('outside any session')
    expect(stepMarkdown(between)).not.toContain('What did it')
  })

  test('the whole timeline is newest first, and says what it is when empty', () => {
    const older = { ...step, date: '2026-09-30' }
    expect(timelineMarkdown([older, step]).split('\n').map(l => l.slice(0, 16))).toEqual(['- **Fri 2 Oct** ', '- **Wed 30 Sep**'])
    expect(timelineMarkdown([])).toContain('No map changes recorded yet')
  })
})
