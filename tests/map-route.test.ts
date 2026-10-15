import { describe, expect, test } from 'claude-code/testing'

import { ROUTE, routeLinks } from '../notepad/app/js/map-route.js'

type Box = { x: number; y: number; w: number; h: number }
type Pt = { x: number; y: number }

const box = (x: number, y: number, w = 100, h = 50): Box => ({ x, y, w, h })
const runs = (pts: Pt[]) => pts.slice(1).map((b, i) => [pts[i], b] as [Pt, Pt])
// Does the run from a to b pass through the inside of r?
const crosses = ([a, b]: [Pt, Pt], r: Box) => {
  const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }
  const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }
  return lo.x < r.x + r.w && hi.x > r.x && lo.y < r.y + r.h && hi.y > r.y
}
const onEdge = (p: Pt, r: Box) =>
  ((p.x === r.x || p.x === r.x + r.w) && p.y >= r.y && p.y <= r.y + r.h) ||
  ((p.y === r.y || p.y === r.y + r.h) && p.x >= r.x && p.x <= r.x + r.w)

describe('routeLinks', () => {
  test('draws a straight line between boxes that face each other', () => {
    const r = routeLinks([{ key: 'k', a: box(0, 0), b: box(300, 0), avoid: [] }]).k
    expect(r.pts).toEqual([{ x: 100, y: 25 }, { x: 300, y: 25 }])
    expect(r.isUpright).toBe(false)
  })

  test('uses only level and upright runs, starting and ending on the boxes', () => {
    const a = box(0, 0); const b = box(300, 200)
    const { pts } = routeLinks([{ key: 'k', a, b, avoid: [] }]).k
    for (const [p, q] of runs(pts)) expect(p.x === q.x || p.y === q.y).toBe(true)
    expect(onEdge(pts[0], a)).toBe(true)
    expect(onEdge(pts[pts.length - 1], b)).toBe(true)
    expect(pts.length).toBeLessThanOrEqual(4)
  })

  test('goes around a box in the way, with room to spare', () => {
    const a = box(0, 0); const b = box(400, 0); const wall = box(200, -20, 100, 90)
    const { pts } = routeLinks([{ key: 'k', a, b, avoid: [wall] }]).k
    const grown = { x: wall.x - ROUTE.GAP + 1, y: wall.y - ROUTE.GAP + 1, w: wall.w + 2 * ROUTE.GAP - 2, h: wall.h + 2 * ROUTE.GAP - 2 }
    for (const run of runs(pts)) expect(crosses(run, grown)).toBe(false)
  })

  test('never passes through its own boxes', () => {
    // b sits behind a: the line has to leave a and come round.
    const a = box(200, 0); const b = box(0, 0)
    const { pts } = routeLinks([{ key: 'k', a, b, avoid: [box(100, -100, 50, 400)] }]).k
    for (const run of runs(pts).slice(1, -1)) {
      expect(crosses(run, a)).toBe(false)
      expect(crosses(run, b)).toBe(false)
    }
  })

  test('spreads lines that leave the same side of a box', () => {
    // Both targets sit to the right of the hub, so both lines leave its right side.
    const hub = box(0, 100)
    const out = routeLinks([
      { key: 'down', a: hub, b: box(300, 140), avoid: [] },
      { key: 'up', a: hub, b: box(300, 60), avoid: [] },
    ])
    expect(out.up.pts[0].x).toBe(100)
    expect(out.down.pts[0].x).toBe(100)
    // Spread along the side, in the order of where they go, so they do not cross.
    expect(out.up.pts[0].y).toBeLessThan(out.down.pts[0].y)
  })

  test('keeps parallel lines apart instead of on top of each other', () => {
    const a = box(0, 0); const b = box(400, 0); const wall = box(200, -20, 100, 90)
    const out = routeLinks([
      { key: 'one', a, b, avoid: [wall] },
      { key: 'two', a, b, avoid: [wall] },
    ])
    const level = (pts: Pt[]) => runs(pts).filter(([p, q]) => p.y === q.y && Math.abs(q.x - p.x) > 200).map(([p]) => p.y)
    const [y1] = level(out.one.pts); const [y2] = level(out.two.pts)
    expect(y1).not.toBe(y2)
  })

  test('a bent line passes through its handle', () => {
    const via = { x: 250, y: 150 }
    const { pts } = routeLinks([{ key: 'k', a: box(0, 0), b: box(400, 0), avoid: [], via }]).k
    for (const [p, q] of runs(pts)) expect(p.x === q.x || p.y === q.y).toBe(true)
    expect(Math.max(...pts.map(p => p.y))).toBe(150)
    const touches = runs(pts).some(([p, q]) => (p.y === via.y && q.y === via.y && Math.min(p.x, q.x) <= via.x && Math.max(p.x, q.x) >= via.x) ||
      (p.x === via.x && q.x === via.x && Math.min(p.y, q.y) <= via.y && Math.max(p.y, q.y) >= via.y))
    expect(touches).toBe(true)
  })

  test('falls back to one elbow when the boxes overlap', () => {
    const { pts } = routeLinks([{ key: 'k', a: box(0, 0), b: box(10, 10), avoid: [] }]).k
    expect(pts.length).toBeGreaterThanOrEqual(2)
    for (const [p, q] of runs(pts)) expect(p.x === q.x || p.y === q.y).toBe(true)
  })

  test('routes a dozen links among a dozen boxes quickly', () => {
    const boxes = Array.from({ length: 12 }, (_, i) => box((i % 4) * 300, Math.floor(i / 4) * 180))
    const links = Array.from({ length: 12 }, (_, i) => ({ key: `l${i}`, a: boxes[i], b: boxes[(i * 5 + 3) % 12], avoid: boxes.filter((_, k) => k !== i && k !== (i * 5 + 3) % 12) }))
    const t0 = Date.now()
    const out = routeLinks(links)
    expect(Object.keys(out).length).toBe(12)
    expect(Date.now() - t0).toBeLessThan(250)
  })
})
