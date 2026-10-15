/* ---------- Lines around boxes, for your arrangement ---------- */

// In your own arrangement every box stays where you put it, so ELK cannot
// route the lines. This router draws them the way ELK does: straight runs and
// right angles, around every box in the way, with as few bends as it can.
// Lines that leave the same side of a box spread along it instead of piling
// onto its middle, and lines avoid running on top of each other.
// Pure geometry, no DOM: an ES module that the page (app.html hands
// routeLinks to the other scripts) and the tests load alike.

const ROUTE = { GAP: 18, BEND: 40, SHARED: 2, SPREAD: 0.6, LANE: 8 }
const SIDES = { l: { x: -1, y: 0 }, r: { x: 1, y: 0 }, t: { x: 0, y: -1 }, b: { x: 0, y: 1 } }

// Where a line touches a box: side `s`, at fraction `f` along it.
const portOn = (r, s, f = 0.5) => (s === 'l' ? { x: r.x, y: r.y + r.h * f }
  : s === 'r' ? { x: r.x + r.w, y: r.y + r.h * f }
  : s === 't' ? { x: r.x + r.w * f, y: r.y } : { x: r.x + r.w * f, y: r.y + r.h })
const stubOf = (p, s, gap) => ({ x: p.x + SIDES[s].x * gap, y: p.y + SIDES[s].y * gap })
const dirOf = (a, b) => (b.x > a.x ? 'r' : b.x < a.x ? 'l' : b.y > a.y ? 'b' : 't')
const flip = { l: 'r', r: 'l', t: 'b', b: 't' }
const segKey = (a, b) => (a.x < b.x || (a.x === b.x && a.y < b.y) ? `${a.x},${a.y},${b.x},${b.y}` : `${b.x},${b.y},${a.x},${a.y}`)

// A point strictly inside a box grown by `m`.
const inside = (p, r, m) => p.x > r.x - m && p.x < r.x + r.w + m && p.y > r.y - m && p.y < r.y + r.h + m

// Drop points that sit on a straight run.
const simplify = pts => pts.filter((p, i) => {
  if (i === 0 || i === pts.length - 1) return true
  const a = pts[i - 1]; const b = pts[i + 1]
  return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y)) && !(a.x === p.x && a.y === p.y)
})

// A tiny binary heap of [cost, state].
const heap = () => {
  const h = []
  return {
    get size() { return h.length },
    push(item) {
      h.push(item)
      for (let i = h.length - 1; i > 0;) {
        const j = (i - 1) >> 1
        if (h[j][0] <= h[i][0]) break
        ;[h[i], h[j]] = [h[j], h[i]]; i = j
      }
    },
    pop() {
      const top = h[0]; const last = h.pop()
      if (h.length) {
        h[0] = last
        for (let i = 0; ;) {
          const l = 2 * i + 1; const r = l + 1
          let m = i
          if (l < h.length && h[l][0] < h[m][0]) m = l
          if (r < h.length && h[r][0] < h[m][0]) m = r
          if (m === i) break
          ;[h[i], h[m]] = [h[m], h[i]]; i = m
        }
      }
      return top
    },
  }
}

// The cheapest right-angled path from any start to any goal, keeping clear of
// `boxes`. Starts and goals are { x, y, dir, cost }: dir is the way the line
// must leave a start, or arrive at a goal (null: any way).
const searchPath = (starts, goals, boxes, used, gap) => {
  const m = gap - 0.5
  const xs = new Set(); const ys = new Set()
  for (const b of boxes) { xs.add(b.x - gap); xs.add(b.x + b.w + gap); ys.add(b.y - gap); ys.add(b.y + b.h + gap) }
  for (const p of [...starts, ...goals]) { xs.add(p.x); ys.add(p.y) }
  const lanes = set => {
    const v = [...set].sort((a, b) => a - b)
    const mids = v.slice(1).map((x, i) => (x + v[i]) / 2).filter((x, i) => v[i + 1] - v[i] > 2 * gap)
    return [...new Set([...v, ...mids])].sort((a, b) => a - b)
  }
  const X = lanes(xs); const Y = lanes(ys)
  const ix = new Map(X.map((x, i) => [x, i])); const iy = new Map(Y.map((y, i) => [y, i]))
  const open = (i, j) => !boxes.some(b => inside({ x: X[i], y: Y[j] }, b, m))
  const clear = (a, b) => !boxes.some(r => inside({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, r, m))
  const goalAt = new Map(goals.map(g => [`${ix.get(g.x)},${iy.get(g.y)}`, g]))
  const h = (i, j) => Math.min(...goals.map(g => Math.abs(X[i] - g.x) + Math.abs(Y[j] - g.y)))
  const best = new Map(); const from = new Map()
  const q = heap()
  for (const s of starts) {
    const i = ix.get(s.x); const j = iy.get(s.y)
    const key = `${i},${j},${s.dir ?? '-'}`
    if (!best.has(key) || best.get(key) > s.cost) { best.set(key, s.cost); from.set(key, null); q.push([s.cost + h(i, j), [i, j, s.dir, s.cost, key]]) }
  }
  const step = { r: [1, 0], l: [-1, 0], b: [0, 1], t: [0, -1] }
  let found = null; let foundCost = Infinity
  while (q.size) {
    const [f, [i, j, dir, g, key]] = q.pop()
    if (f >= foundCost) break
    if (g > best.get(key)) continue
    const goal = goalAt.get(`${i},${j}`)
    if (goal) {
      const total = g + (goal.dir && dir && dir !== goal.dir ? ROUTE.BEND : 0) + (goal.cost ?? 0)
      if (total < foundCost) { foundCost = total; found = key }
    }
    for (const [d, [di, dj]] of Object.entries(step)) {
      if (dir && d === flip[dir]) continue
      const ni = i + di; const nj = j + dj
      if (ni < 0 || nj < 0 || ni >= X.length || nj >= Y.length || !open(ni, nj)) continue
      const a = { x: X[i], y: Y[j] }; const b = { x: X[ni], y: Y[nj] }
      if (!clear(a, b)) continue
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
      const cost = g + len * (used.has(segKey(a, b)) ? ROUTE.SHARED : 1) + (dir && d !== dir ? ROUTE.BEND : 0)
      const nk = `${ni},${nj},${d}`
      if (best.has(nk) && best.get(nk) <= cost) continue
      best.set(nk, cost); from.set(nk, key)
      q.push([cost + h(ni, nj), [ni, nj, d, cost, nk]])
    }
  }
  if (!found) return null
  const pts = []
  for (let k = found; k; k = from.get(k)) { const [i, j] = k.split(','); pts.unshift({ x: X[+i], y: Y[+j] }) }
  return pts
}

// One leg from box (or point) `a` to box (or point) `b`. A box end may be
// pinned to a side and a spot along it; otherwise any side will do. A point
// start may carry the way the line is already heading (`dir`).
const routeLeg = (a, b, boxes, used, gap) => {
  const ends = (e, isStart) => {
    if (!e.w && !e.h) return [{ x: e.x, y: e.y, dir: isStart ? e.dir ?? null : null, cost: 0, port: null }]
    const sides = e.side ? [e.side] : Object.keys(SIDES)
    return sides.map(s => {
      const port = portOn(e, s, e.at ?? 0.5)
      const stub = stubOf(port, s, gap)
      return { x: stub.x, y: stub.y, dir: isStart ? s : flip[s], cost: 0, port, side: s }
    })
  }
  const starts = ends(a, true); const goals = ends(b, false)
  const path = searchPath(starts, goals, boxes, used, gap)
  if (!path) return null
  const first = starts.find(s => s.x === path[0].x && s.y === path[0].y)
  const last = goals.find(g => g.x === path[path.length - 1].x && g.y === path[path.length - 1].y)
  return { pts: [...(first?.port ? [first.port] : []), ...path, ...(last?.port ? [last.port] : [])], sideA: first?.side, sideB: last?.side }
}

// Where the label and the bend handle go: the middle of the longest run,
// preferring a level one.
const midOf = pts => {
  let pick = null
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]; const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const score = len * (a.y === b.y ? 1.6 : 1)
    if (!pick || score > pick.score) pick = { score, a, b }
  }
  if (!pick) return { mx: pts[0].x, my: pts[0].y, isUpright: false }
  return { mx: (pick.a.x + pick.b.x) / 2, my: (pick.a.y + pick.b.y) / 2, isUpright: pick.a.x === pick.b.x && pick.a.y !== pick.b.y }
}

// Lines that still run on top of each other, side by side instead: middle
// runs (both ends are bends, so the port ends stay put) that share a level or
// upright line and overlap move apart, centred on where they were.
const nudge = routes => {
  const groups = new Map()
  routes.forEach((pts, li) => {
    for (let k = 2; k < pts.length - 1; k++) {
      const a = pts[k - 1]; const b = pts[k]
      const isLevel = a.y === b.y
      const at = isLevel ? a.y : a.x
      const lo = Math.min(isLevel ? a.x : a.y, isLevel ? b.x : b.y); const hi = Math.max(isLevel ? a.x : a.y, isLevel ? b.x : b.y)
      const key = `${isLevel ? 'h' : 'v'}${at}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push({ li, k, isLevel, lo, hi })
    }
  })
  for (const list of groups.values()) {
    if (list.length < 2) continue
    // Runs that overlap form one bundle; each bundle spreads on its own.
    list.sort((p, q) => p.lo - q.lo)
    const bundles = []
    for (const s of list) {
      const last = bundles[bundles.length - 1]
      if (last && s.lo < last.hi) { last.runs.push(s); last.hi = Math.max(last.hi, s.hi) } else bundles.push({ hi: s.hi, runs: [s] })
    }
    for (const { runs } of bundles) {
      if (runs.length < 2) continue
      runs.sort((p, q) => p.li - q.li)
      runs.forEach((s, n) => {
        const off = (n - (runs.length - 1) / 2) * ROUTE.LANE
        const pts = routes[s.li]
        for (const p of [pts[s.k - 1], pts[s.k]]) { if (s.isLevel) p.y += off; else p.x += off }
      })
    }
  }
}

// When every way is blocked (boxes on top of each other): one elbow.
const elbow = (a, b) => {
  const ca = { x: a.x + (a.w ?? 0) / 2, y: a.y + (a.h ?? 0) / 2 }; const cb = { x: b.x + (b.w ?? 0) / 2, y: b.y + (b.h ?? 0) / 2 }
  return [ca, { x: cb.x, y: ca.y }, cb]
}

/**
 * Route every link. Each link is { key, a, b, avoid, via?, gap? }: a and b
 * are the boxes it joins ({ x, y, w, h }), avoid the boxes it must go around
 * (a and b are added), via an optional point it must pass (a bent line), gap
 * the room it keeps from every box (ROUTE.GAP unless given). Returns
 * { [key]: { pts, mx, my, isUpright } }, pts running from a to b.
 */
const routeLinks = links => {
  const out = {}
  const legsOf = (l, used, pin) => {
    const boxes = [...l.avoid, l.a, l.b]
    const a = { ...l.a, ...(pin?.a ?? {}) }; const b = { ...l.b, ...(pin?.b ?? {}) }
    const gap = l.gap ?? ROUTE.GAP
    const via = l.via && !boxes.some(r => inside(l.via, r, gap - 0.5)) ? l.via : null
    if (!via) return routeLeg(a, b, boxes, used, gap)
    // On through the handle: the second leg may turn there, never double back.
    const one = routeLeg(a, via, boxes, used, gap)
    const n = one?.pts.length ?? 0
    const two = one && routeLeg({ ...via, dir: n > 1 ? dirOf(one.pts[n - 2], one.pts[n - 1]) : null }, b, boxes, used, gap)
    return two ? { pts: [...one.pts, ...two.pts.slice(1)], sideA: one.sideA, sideB: two.sideB } : routeLeg(a, b, boxes, used, gap)
  }
  // Pass 1: free sides, to learn which side of each box every line uses.
  const first = links.map(l => legsOf(l, new Set()))
  // Spread lines sharing a side, ordered by where their other end lies.
  const sideUse = new Map()
  const note = (box, side, link, end, toward) => {
    if (!side) return
    const k = `${box.x},${box.y},${box.w},${box.h},${side}`
    if (!sideUse.has(k)) sideUse.set(k, [])
    sideUse.get(k).push({ link, end, at: side === 'l' || side === 'r' ? toward.y : toward.x })
  }
  const centre = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  links.forEach((l, i) => {
    const r = first[i]
    if (!r) return
    note(l.a, r.sideA, i, 'a', l.via ?? centre(l.b))
    note(l.b, r.sideB, i, 'b', l.via ?? centre(l.a))
  })
  const pins = links.map(() => ({}))
  for (const list of sideUse.values()) {
    list.sort((p, q) => p.at - q.at)
    list.forEach((p, k) => {
      const f = list.length === 1 ? 0.5 : 0.5 - ROUTE.SPREAD / 2 + (ROUTE.SPREAD * k) / (list.length - 1)
      const side = p.end === 'a' ? first[p.link].sideA : first[p.link].sideB
      pins[p.link][p.end] = { side, at: f }
    })
  }
  // Pass 2: pinned ports, and runs already taken cost more.
  const used = new Set()
  const routes = []
  links.forEach((l, i) => {
    const r = legsOf(l, used, pins[i]) ?? first[i]
    // The grid steps it takes, before straight runs merge, mark the way as taken.
    if (r) for (let k = 1; k < r.pts.length; k++) used.add(segKey(r.pts[k - 1], r.pts[k]))
    routes.push(r ? simplify(r.pts).map(p => ({ ...p })) : elbow(l.a, l.b))
  })
  nudge(routes)
  links.forEach((l, i) => { out[l.key] = { pts: routes[i], ...midOf(routes[i]) } })
  return out
}

export { routeLinks, ROUTE }
