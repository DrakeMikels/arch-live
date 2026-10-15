/* ---------- The map: one canvas, components open in place ---------- */

// The Diagram tab draws the map itself (the pane keeps the static drawing):
// click a component and it opens where it sits, its parts inside. ELK (the
// layout engine behind Mermaid's cleaner layouts) places every box and routes
// every line around them; the boxes glide between layouts and the lines fade
// onto their new routes, and a big change (a re-map) builds up tier by tier
// (buildMap in map.js). Without ELK, a simpler column layout draws instead.
let mapData = null
let mapLayout = null
let mapAnim = 0
let mapTicket = 0
let mapDragged = false
const mapView = { x: 0, y: 0, z: 1, isFitted: false }
// Which layout draws the map, and whether components can be dragged (per browser).
const mapPrefs = (() => {
  try { return { mode: 'lr', isLocked: true, overlay: 'none', ...JSON.parse(localStorage.getItem(`arch-live-mapprefs:${token}`) || '{}') } } catch { return { mode: 'lr', isLocked: true, overlay: 'none' } }
})()
const savePrefs = () => { try { localStorage.setItem(`arch-live-mapprefs:${token}`, JSON.stringify(mapPrefs)) } catch {} }
const elk = typeof ELK === 'function' ? new ELK() : null
const openSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(`arch-live-open:${token}`) || '[]')) } catch { return new Set() } })()
const keepOpen = () => { try { localStorage.setItem(`arch-live-open:${token}`, JSON.stringify([...openSet])) } catch {} }
// The server keeps which components are open, so the Claude Code pane opens
// and closes them with you.
const saveOpen = () => { keepOpen(); api('/api/view', { open: [...openSet] }).catch(() => {}) }
const TIER = { client: 0, edge: 1, service: 2, worker: 2, queue: 3, store: 4, external: 5 }
const TIER_LABEL = ['CLIENTS', 'EDGE', 'SERVICES', 'MESSAGING', 'DATA', 'EXTERNAL']
const M = { NW: 236, PW: 214, PAD: 16, GAP: 120, RGY: 28 }
// Character widths of the monospace type at each size, for wrapping.
const CH = { label: 8.6, sub: 6.4, plabel: 7.7 }

const partsFor = n => (n?.breakdown?.parts?.length
  ? { parts: n.breakdown.parts, edges: n.breakdown.edges ?? [], isQuick: false }
  : { parts: n?.quick ?? [], edges: [], isQuick: true })

// Words into at most `lines` lines of `width` pixels; the last ends in … when cut.
const wrapText = (text, width, ch, lines) => {
  const max = Math.max(4, Math.floor(width / ch))
  const out = []
  let cur = ''
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word
    if (next.length <= max) { cur = next; continue }
    if (cur) out.push(cur)
    cur = word.length > max ? `${word.slice(0, max - 1)}…` : word
    if (out.length === lines) break
  }
  if (cur && out.length < lines) out.push(cur)
  if (out.length > lines || (out.length === lines && String(text ?? '').length > out.join(' ').length + 1)) {
    out.length = lines
    out[lines - 1] = `${out[lines - 1].slice(0, max - 1).replace(/\s+\S*$/, '') || out[lines - 1].slice(0, max - 1)}…`
  }
  return out
}

// What each box says, wrapped, and how tall that makes it.
const nodeText = (n, isOpen) => {
  const w = isOpen ? M.NW + 120 : M.NW
  const label = wrapText(n.label, w - 30, CH.label, 2)
  const pv = partsFor(n)
  const sub = isOpen && pv.isQuick ? [] : wrapText(n.sublabel, w - 30, CH.sub, isOpen ? 1 : 2)
  const head = 26 + label.length * 18 + sub.length * 14 + (isOpen && pv.isQuick ? 14 : 0) + 10
  return { label, sub, head, h: head + 2 }
}
const partText = p => {
  const label = wrapText(p.label, M.PW - 40, CH.plabel, 2)
  const sub = wrapText(p.summary, M.PW - 40, CH.sub, 3)
  return { label, sub, h: 28 + label.length * 16 + sub.length * 13 + 8 }
}

// Which part a component link should start or end on, when it is open.
const linkEnds = () => {
  const byId = Object.fromEntries(mapData.nodes.map(n => [n.id, n]))
  const ends = []
  const used = new Set()
  for (const [i, e] of mapData.edges.entries()) {
    if (!byId[e.from] || !byId[e.to]) continue
    let from = e.from
    let to = e.to
    const pf = openSet.has(e.from) && (byId[e.from].breakdown?.edges ?? []).find(x => x.to === e.to && partsFor(byId[e.from]).parts.some(p => p.id === x.from))
    if (pf) { from = `${e.from}/${pf.from}`; used.add(`${e.from}|${pf.from}|${e.to}`) }
    const pt = openSet.has(e.to) && (byId[e.to].breakdown?.edges ?? []).find(x => x.from === e.from && partsFor(byId[e.to]).parts.some(p => p.id === x.to))
    if (pt) { to = `${e.to}/${pt.to}`; used.add(`${e.to}|${e.from}|${pt.to}`) }
    ends.push({ id: `e${i}`, from, to, label: e.label ?? '', style: e.style ?? 'call' })
  }
  // A part's own links to other components that the map has no line for.
  for (const n of mapData.nodes) {
    if (!openSet.has(n.id)) continue
    const ids = new Set(partsFor(n).parts.map(p => p.id))
    for (const [i, x] of (n.breakdown?.edges ?? []).entries()) {
      if (ids.has(x.from) && !ids.has(x.to) && byId[x.to] && !used.has(`${n.id}|${x.from}|${x.to}`)) ends.push({ id: `x${n.id}${i}`, from: `${n.id}/${x.from}`, to: x.to, label: x.label ?? '', style: 'thin' })
      else if (ids.has(x.to) && !ids.has(x.from) && byId[x.from] && !used.has(`${n.id}|${x.from}|${x.to}`) && !mapData.edges.some(e => e.from === x.from && e.to === n.id)) ends.push({ id: `x${n.id}${i}`, from: x.from, to: `${n.id}/${x.to}`, label: x.label ?? '', style: 'thin' })
    }
  }
  return ends
}
const labelBox = text => (text ? [{ text, width: Math.min(150, text.length * 5.8 + 10), height: 13 }] : [])

// The map as an ELK graph: tiers are partitions (columns, as in the pane);
// open components hold their parts and their parts' links.
const elkGraph = () => {
  const children = mapData.nodes.map(n => {
    const isOpen = openSet.has(n.id)
    const t = nodeText(n, isOpen)
    const node = { id: n.id, width: isOpen ? M.NW + 120 : M.NW, height: t.h, layoutOptions: { 'elk.partitioning.partition': String(TIER[n.kind] ?? 2) } }
    if (isOpen) {
      const pv = partsFor(n)
      const ids = new Set(pv.parts.map(p => p.id))
      node.children = pv.parts.map(p => ({ id: `${n.id}/${p.id}`, width: M.PW, height: partText(p).h }))
      node.edges = pv.edges.filter(x => ids.has(x.from) && ids.has(x.to) && x.from !== x.to).map((x, i) => ({ id: `i${n.id}${i}`, sources: [`${n.id}/${x.from}`], targets: [`${n.id}/${x.to}`], labels: labelBox(x.label) }))
      node.layoutOptions = {
        ...node.layoutOptions,
        'elk.padding': `[top=${t.head + 8},left=${M.PAD},bottom=${M.PAD},right=${M.PAD}]`,
        'elk.layered.spacing.nodeNodeBetweenLayers': '46',
        'elk.spacing.nodeNode': '16',
        // At least as wide as its header, however few parts it holds.
        'elk.direction': 'RIGHT',
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${M.NW + 120}, ${t.h + 30})`,
      }
      delete node.height
      if (!node.children.length) node.height = t.h + 30
    }
    return node
  })
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': mapPrefs.mode === 'td' ? 'DOWN' : 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      // Tiers as columns (or rows, top down); Compact lets connections alone decide.
      'elk.partitioning.activate': mapPrefs.mode === 'compact' ? 'false' : 'true',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(M.GAP),
      'elk.spacing.nodeNode': String(M.RGY),
      'elk.spacing.edgeNode': '18',
      'elk.spacing.edgeEdge': '10',
      'elk.layered.spacing.edgeNodeBetweenLayers': '18',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.padding': '[top=40,left=20,bottom=20,right=20]',
    },
    children,
    edges: linkEnds().map(x => ({ id: x.id, sources: [x.from], targets: [x.to], labels: labelBox(x.label), style: x.style })),
  }
}

// ELK's answer as absolute boxes, routes and label spots.
const fromElk = (res, graph) => {
  const L = { nodes: {}, parts: {}, edges: [], tiers: [], w: res.width, h: res.height, routed: true }
  const styleOf = Object.fromEntries(graph.edges.map(e => [e.id, e.style]))
  const addEdges = (list, ox, oy) => {
    for (const e of list ?? []) {
      const s = e.sections?.[0]
      if (!s) continue
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(p => ({ x: p.x + ox, y: p.y + oy }))
      // from and to: what the line joins (a component, or "component/part").
      L.edges.push({ id: e.id, from: e.sources?.[0], to: e.targets?.[0], pts, style: styleOf[e.id] ?? 'call', labels: (e.labels ?? []).map(l => ({ text: l.text, x: l.x + ox + l.width / 2, y: l.y + oy + l.height - 3 })) })
    }
  }
  for (const c of res.children ?? []) {
    L.nodes[c.id] = { x: c.x, y: c.y, w: c.width, h: c.height, a: 1 }
    for (const k of c.children ?? []) L.parts[k.id] = { x: c.x + k.x, y: c.y + k.y, w: k.width, h: k.height, a: 1 }
    addEdges(c.edges, c.x, c.y)
  }
  addEdges(res.edges, 0, 0)
  if (mapPrefs.mode === 'compact') return L
  // Tier labels: above each column, or at the start of each row top down.
  const isRows = mapPrefs.mode === 'td'
  const tiers = {}
  for (const n of mapData.nodes) {
    const r = L.nodes[n.id]
    const t = TIER[n.kind] ?? 2
    if (r) tiers[t] = Math.min(tiers[t] ?? Infinity, isRows ? r.y : r.x)
  }
  L.tiers = Object.entries(tiers).map(([t, at]) => ({ label: TIER_LABEL[t], x: isRows ? undefined : at, y: isRows ? at : undefined })).sort((a, b) => (a.x ?? a.y) - (b.x ?? b.y))
  return L
}

// Without ELK: tiers as columns, parts in a grid, lines drawn as curves.
const columnLayout = () => {
  const L = { nodes: {}, parts: {}, tiers: [], edges: [], w: 0, h: 0, routed: false }
  const cols = TIER_LABEL.map(() => [])
  for (const n of [...mapData.nodes].sort((a, b) => a.order - b.order)) cols[TIER[n.kind] ?? 2].push(n)
  const size = n => {
    const t = nodeText(n, openSet.has(n.id))
    if (!openSet.has(n.id)) return { w: M.NW, h: t.h, at: {} }
    const parts = partsFor(n).parts
    const per = Math.max(1, Math.ceil(parts.length / 2))
    const at = {}
    let colY = [t.head + 8, t.head + 8]
    parts.forEach((p, i) => { const c = Math.floor(i / per); at[p.id] = { x: M.PAD + c * (M.PW + 30), y: colY[c] }; colY[c] += partText(p).h + 14 })
    return { w: Math.max(M.NW, M.PAD * 2 + (parts.length > 1 ? 2 : 1) * M.PW + (parts.length > 1 ? 30 : 0)), h: Math.max(...colY) + M.PAD, at }
  }
  const sizes = Object.fromEntries(mapData.nodes.map(n => [n.id, size(n)]))
  const used = cols.map((c, i) => ({ i, c, w: Math.max(0, ...c.map(n => sizes[n.id].w)), h: c.reduce((s, n) => s + sizes[n.id].h, 0) + Math.max(0, c.length - 1) * M.RGY })).filter(x => x.c.length)
  const maxH = Math.max(0, ...used.map(x => x.h))
  let x = 20
  for (const col of used) {
    L.tiers.push({ label: TIER_LABEL[col.i], x })
    let y = 40 + (maxH - col.h) / 2
    for (const n of col.c) {
      const s = sizes[n.id]
      L.nodes[n.id] = { x: x + (col.w - s.w) / 2, y, w: s.w, h: s.h, a: 1 }
      for (const [pid, r] of Object.entries(s.at)) L.parts[`${n.id}/${pid}`] = { x: L.nodes[n.id].x + r.x, y: y + r.y, w: M.PW, h: partText(partsFor(n).parts.find(p => p.id === pid)).h, a: 1 }
      y += s.h + M.RGY
    }
    x += col.w + M.GAP
  }
  L.w = x - M.GAP + 20
  L.h = maxH + 60
  return L
}

// An open component on its own, its parts laid out by ELK (or a grid).
const innerLayout = async n => {
  const t = nodeText(n, true)
  const pv = partsFor(n)
  const ids = new Set(pv.parts.map(p => p.id))
  if (elk && pv.parts.length) {
    try {
      const res = await elk.layout({
        id: 'inner',
        layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.padding': `[top=${t.head + 8},left=${M.PAD},bottom=${M.PAD},right=${M.PAD}]`, 'elk.layered.spacing.nodeNodeBetweenLayers': '46', 'elk.spacing.nodeNode': '16' },
        children: pv.parts.map(p => ({ id: p.id, width: M.PW, height: partText(p).h })),
        edges: pv.edges.filter(x => ids.has(x.from) && ids.has(x.to) && x.from !== x.to).map((x, i) => ({ id: `i${i}`, sources: [x.from], targets: [x.to] })),
      })
      return { w: Math.max(res.width, M.NW + 120), h: Math.max(res.height, t.h + 30), at: Object.fromEntries((res.children ?? []).map(c => [c.id, { x: c.x, y: c.y, w: c.width, h: c.height }])) }
    } catch {}
  }
  const at = {}
  let y = t.head + 8
  for (const p of pv.parts) { const h = partText(p).h; at[p.id] = { x: M.PAD, y, w: M.PW, h }; y += h + 14 }
  return { w: Math.max(M.NW + 120, M.PW + M.PAD * 2), h: Math.max(y + M.PAD, t.h + 30), at }
}

// Your arrangement: components where you dragged them (new ones where the
// left-to-right layout would put them), each open one sized to its parts.
const customLayout = async () => {
  const saved = mapData.arrangement?.positions ?? {}
  const missing = mapData.nodes.some(n => !saved[n.id])
  const auto = missing ? await autoLayout('lr') : null
  const L = { nodes: {}, parts: {}, tiers: [], edges: [], w: 0, h: 0, minX: 0, minY: 0, routed: false, isCustom: true }
  for (const n of mapData.nodes) {
    const at = saved[n.id] ?? auto?.nodes[n.id] ?? { x: 0, y: 0 }
    if (openSet.has(n.id)) {
      const inner = await innerLayout(n)
      L.nodes[n.id] = { x: at.x, y: at.y, w: inner.w, h: inner.h, a: 1 }
      for (const [pid, r] of Object.entries(inner.at)) L.parts[`${n.id}/${pid}`] = { x: at.x + r.x, y: at.y + r.y, w: r.w, h: r.h, a: 1 }
    } else {
      L.nodes[n.id] = { x: at.x, y: at.y, w: M.NW, h: nodeText(n, false).h, a: 1 }
    }
  }
  const rs = Object.values(L.nodes)
  L.minX = Math.min(...rs.map(r => r.x)) - 20
  L.minY = Math.min(...rs.map(r => r.y)) - 40
  L.w = Math.max(...rs.map(r => r.x + r.w)) + 20 - L.minX
  L.h = Math.max(...rs.map(r => r.y + r.h)) + 20 - L.minY
  return L
}

const autoLayout = async mode => {
  const was = mapPrefs.mode
  if (mode) mapPrefs.mode = mode
  try {
    if (elk) {
      try {
        const graph = elkGraph()
        return fromElk(await elk.layout(graph), graph)
      } catch (err) {
        console.warn('arch-live: ELK layout failed, using columns', err)
      }
    }
    return columnLayout()
  } finally {
    mapPrefs.mode = was
  }
}

const computeLayout = async () => {
  if (!mapData?.nodes?.length) return { nodes: {}, parts: {}, tiers: [], edges: [], w: 0, h: 0, routed: false }
  if (mapPrefs.mode === 'custom') return customLayout()
  if (elk) {
    try {
      const graph = elkGraph()
      return fromElk(await elk.layout(graph), graph)
    } catch (err) {
      console.warn('arch-live: ELK layout failed, using columns', err)
    }
  }
  return columnLayout()
}
