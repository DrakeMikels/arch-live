import { describe, expect, test } from 'claude-code/testing'

import type { ArchGraph } from '../types'
import { outline, popoutHtml, renderSvg } from '../hooks/render'
import { DEFAULT_THEME } from '../hooks/theme'

const graph: ArchGraph = {
  version: 1,
  title: 'Shop <beta>',
  nodes: [
    { id: 'web', label: 'Web & Mobile', kind: 'client', order: 0 },
    { id: 'api', label: 'Orders API', kind: 'service', sublabel: 'Node · :3000', order: 1 },
    { id: 'db', label: 'Postgres', kind: 'store', order: 2 },
  ],
  edges: [
    { from: 'web', to: 'api', label: 'REST', style: 'http' },
    { from: 'api', to: 'db', label: 'SQL' },
  ],
  focus: ['api'],
  updatedAt: 0,
}

describe('renderSvg', () => {
  test('draws an empty map without failing', () => {
    const d = renderSvg(null, DEFAULT_THEME)
    expect(d.svg).toStartWith('<svg')
    expect(d.width).toBeGreaterThan(0)
  })

  test('draws every component, escaping its text', () => {
    const d = renderSvg(graph, DEFAULT_THEME)
    expect(d.svg).toContain('Web &amp; Mobile')
    expect(d.svg).not.toContain('Web & Mobile')
    expect(d.svg).toContain('Orders API')
    expect(d.svg).toContain('Postgres')
    expect(d.alt.length).toBeGreaterThan(0)
  })

  test('tags what the latest change added or changed', () => {
    const d = renderSvg(graph, DEFAULT_THEME, undefined, { fresh: { added: ['db'], changed: ['api'] } })
    expect(d.svg).toContain('NEW')
    expect(d.svg).toContain('UPDATED')
    expect(renderSvg(graph, DEFAULT_THEME).svg).not.toContain('UPDATED')
  })

  test('the same map draws the same way every time', () => {
    expect(renderSvg(graph, DEFAULT_THEME, 600).svg).toBe(renderSvg(graph, DEFAULT_THEME, 600).svg)
  })

  test('left to right on its own; top to bottom in a pane of a given width', () => {
    expect(renderSvg(graph, DEFAULT_THEME).orientation).toBe('horizontal')
    expect(renderSvg(graph, DEFAULT_THEME, 600).orientation).toBe('vertical')
  })

  test('a crowded tier wraps onto more rows to fit a narrow pane', () => {
    const crowded: ArchGraph = {
      ...graph,
      nodes: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, label: `Service ${i}`, kind: 'service' as const, order: i })),
      edges: [],
    }
    const roomy = renderSvg(crowded, DEFAULT_THEME, 4000)
    const narrow = renderSvg(crowded, DEFAULT_THEME, 500)
    expect(narrow.width).toBeLessThan(roomy.width)
    expect(narrow.height).toBeGreaterThan(roomy.height)
  })
})

describe('outline and popoutHtml', () => {
  test('the terminal outline names every component', () => {
    const text = outline(graph)
    for (const n of graph.nodes) expect(text).toContain(n.label)
  })

  test('the browser view is a whole page around the drawing', () => {
    const html = popoutHtml(renderSvg(graph, DEFAULT_THEME), DEFAULT_THEME)
    expect(html).toContain('<svg')
    expect(html.toLowerCase()).toContain('<html')
  })
})
