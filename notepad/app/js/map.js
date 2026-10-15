/* ---------- Drawing the map ---------- */

const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const mix = (a, b, t) => a + (b - a) * t
// A frame between two layouts: boxes glide and resize; parts that appear fade
// in once there is room, parts that go fade out first; old lines fade out and
// the new routes fade in as the boxes settle.
const between = (A, B, t) => {
  const k = ease(t)
  const out = { nodes: {}, parts: {}, tiers: B.tiers, w: mix(A.w, B.w, k), h: mix(A.h, B.h, k), routed: B.routed, edges: [] }
  for (const id of new Set([...Object.keys(A.nodes), ...Object.keys(B.nodes)])) {
    const a = A.nodes[id]; const b = B.nodes[id]
    out.nodes[id] = a && b ? { x: mix(a.x, b.x, k), y: mix(a.y, b.y, k), w: mix(a.w, b.w, k), h: mix(a.h, b.h, k), a: 1 } : { ...(b ?? a), a: b ? k : 1 - k }
  }
  for (const id of new Set([...Object.keys(A.parts), ...Object.keys(B.parts)])) {
    const a = A.parts[id]; const b = B.parts[id]
    const nid = id.slice(0, id.indexOf('/'))
    const node = out.nodes[nid]
    if (a && b) out.parts[id] = { x: mix(a.x, b.x, k), y: mix(a.y, b.y, k), w: mix(a.w, b.w, k), h: mix(a.h, b.h, k), a: 1 }
    else if (b) out.parts[id] = { x: node.x + (b.x - B.nodes[nid].x), y: node.y + (b.y - B.nodes[nid].y), w: b.w, h: b.h, a: Math.max(0, (t - 0.55) / 0.45) }
    else out.parts[id] = { x: node.x + (a.x - A.nodes[nid].x), y: node.y + (a.y - A.nodes[nid].y), w: a.w, h: a.h, a: Math.max(0, 1 - t / 0.3) }
  }
  const fadeOut = Math.max(0, 1 - t / 0.3)
  const fadeIn = Math.max(0, (t - 0.72) / 0.28)
  if (A.routed && fadeOut > 0) out.edges.push(...A.edges.map(e => ({ ...e, a: fadeOut })))
  if (B.routed && fadeIn > 0) out.edges.push(...B.edges.map(e => ({ ...e, a: fadeIn })))
  return out
}

// An orthogonal route with softly rounded corners.
const roundRoute = pts => {
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1]; const p1 = pts[i]; const p2 = pts[i + 1]
    const r = Math.min(8, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2)
    const a = { x: p1.x + Math.sign(p0.x - p1.x) * r, y: p1.y + Math.sign(p0.y - p1.y) * r }
    const b = { x: p1.x + Math.sign(p2.x - p1.x) * r, y: p1.y + Math.sign(p2.y - p1.y) * r }
    d += ` L ${a.x} ${a.y} Q ${p1.x} ${p1.y} ${b.x} ${b.y}`
  }
  const last = pts[pts.length - 1]
  return `${d} L ${last.x} ${last.y}`
}
// A note's text without its formatting marks, for places that draw plain text.
const plainText = t => String(t ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/~~([^~]+)~~/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, '$1$2').replace(/^\s*[-*] /gm, '').replace(/\s*\n\s*/g, ' · ')
const cutText = (t, n) => (String(t ?? '').length > n ? `${String(t).slice(0, n - 1)}…` : String(t ?? ''))
// A line you bent in your arrangement passes through its handle. The handle
// is kept relative to the midpoint of the two boxes, so it follows them.
const centerOf = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const bendHandle = (ra, rb, off) => {
  const a = centerOf(ra); const b = centerOf(rb)
  return { x: (a.x + b.x) / 2 + off.dx, y: (a.y + b.y) / 2 + off.dy }
}
const bendsOf = () => mapData?.arrangement?.bends ?? {}
const canBend = L => L.isCustom && !mapPrefs.isLocked
// The handle of an unbent line: the middle of its longest run, where a drag starts from.
const midHandle = (ra, rb, p) => ({ x: p.mx, y: p.my, dx: p.mx - (centerOf(ra).x + centerOf(rb).x) / 2, dy: p.my - (centerOf(ra).y + centerOf(rb).y) / 2 })

// Overlays: the map tinted by what the journal knows (/api/insights).
let mapInsights = null
const OVERLAYS = {
  none: { label: 'No overlay', legend: '' },
  activity: { label: 'Recent activity', legend: 'Darker: more turns in the last 4 weeks' },
  uncommitted: { label: 'Not committed', legend: 'Files changed that no commit has taken yet' },
  tests: { label: 'Tests', legend: 'The last test run after work on each component' },
}
const agoText = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago` }
// What the overlay says about one component: a tint, how strong, and a word.
const overlayOf = id => {
  const c = mapInsights?.components?.[id]
  const mode = mapPrefs.overlay
  if (!c || mode === 'none') return null
  if (mode === 'activity') {
    const most = Math.max(1, ...Object.values(mapInsights.components).map(x => x.turns))
    return c.turns ? { tone: 'accent', a: 0.1 + 0.35 * (c.turns / most), text: `${c.turns} turn${c.turns > 1 ? 's' : ''} · ${agoText(c.lastAt)}` } : null
  }
  if (mode === 'uncommitted') return c.uncommitted.length ? { tone: 'warn', a: 0.22, text: `${c.uncommitted.length} file${c.uncommitted.length > 1 ? 's' : ''} not committed` } : null
  if (mode === 'tests' && c.tests) return c.tests.failed ? { tone: 'bad', a: 0.24, text: `✗ ${c.tests.failed} failing` } : { tone: 'good', a: 0.16, text: `✓ ${c.tests.passed} passed` }
  return null
}

// Focus: hovering a component fades what it does not touch; shift-clicking
// two components lights the shortest path between them.
const mapFocus = { hover: null, path: null }
const ownerOf = id => (String(id).includes('/') ? String(id).slice(0, String(id).indexOf('/')) : String(id))
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
const neighborsOf = id => new Set((mapData?.edges ?? []).flatMap(e => (e.from === id ? [e.to] : e.to === id ? [e.from] : [])))
// The shortest chain of connections from a to b, either direction; null when none.
const pathBetween = (a, b) => {
  const prev = new Map([[a, null]])
  const queue = [a]
  while (queue.length) {
    const at = queue.shift()
    if (at === b) break
    for (const next of neighborsOf(at)) if (!prev.has(next)) { prev.set(next, at); queue.push(next) }
  }
  if (!prev.has(b)) return null
  const ids = []
  for (let at = b; at !== null; at = prev.get(at)) ids.unshift(at)
  return ids
}
// What stays lit: null when nothing is focused.
const litSets = () => {
  if (mapFocus.path?.ids?.length === 2 && mapFocus.path.chain) {
    const chain = mapFocus.path.chain
    return { nodes: new Set(chain), pairs: new Set(chain.slice(1).map((id, i) => pairKey(chain[i], id))) }
  }
  if (mapFocus.path?.ids?.length === 1) {
    const id = mapFocus.path.ids[0]
    return { nodes: new Set([id, ...neighborsOf(id)]), pairs: new Set([...neighborsOf(id)].map(x => pairKey(id, x))) }
  }
  const id = mapFocus.hover
  if (!id || !mapData?.nodes.some(n => n.id === id)) return null
  return { nodes: new Set([id, ...neighborsOf(id)]), pairs: new Set([...neighborsOf(id)].map(x => pairKey(id, x))) }
}
const isEdgeLit = (lit, from, to) => {
  if (!lit) return true
  const a = ownerOf(from); const b = ownerOf(to)
  return a === b ? lit.nodes.has(a) : lit.pairs.has(pairKey(a, b))
}

const mapLines = (lines, x, y, lh, cls) => (lines.length ? `<text class="${cls}">${lines.map((l, i) => `<tspan x="${x}" y="${y + i * lh}">${esc(l)}</tspan>`).join('')}</text>` : '')

// The map's SVG content for a layout. For an export, nothing interactive:
// no selection, no counts or buttons, no live marker.
const mapMarkup = (L, isExport = false) => {
  if (!mapData) return ''
  const out = []
  out.push(`<defs>${['muted', 'link', 'soft'].map(c => `<marker id="m-${c}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" style="fill:var(--${c})"/></marker>`).join('')}</defs>`)
  const top = Math.min(...Object.values(L.nodes).map(r => r.y), 40)
  const left = Math.min(...Object.values(L.nodes).map(r => r.x), 20)
  for (const t of L.tiers) out.push(t.y !== undefined ? `<text x="${left}" y="${t.y - 10}" class="m-tier">${t.label}</text>` : `<text x="${t.x}" y="${top - 16}" class="m-tier">${t.label}</text>`)
  const edgeClass = s => (s === 'http' ? 'http' : s === 'async' ? 'async' : s === 'thin' ? 'thin' : '')
  const marker = s => (s === 'http' ? 'link' : s === 'thin' ? 'soft' : 'muted')
  const edgeOut = []
  const handleOut = []
  const lit = isExport ? null : litSets()
  const dimAttr = (from, to) => (isEdgeLit(lit, from, to) ? '' : ' class="dim"')
  if (L.routed) {
    for (const e of L.edges) {
      if (e.a <= 0.01) continue
      // A line being built (draw < 1) is drawn that far along; its arrowhead
      // and label come once it arrives.
      const draw = e.draw ?? 1
      const drawing = draw < 1 ? ` pathLength="1" style="stroke-dasharray:1 1;stroke-dashoffset:${(1 - draw).toFixed(3)}"` : ''
      const arrow = draw >= 0.98 ? ` marker-end="url(#m-${marker(e.style)})"` : ''
      const labelA = draw < 1 ? Math.max(0, (draw - 0.6) / 0.4).toFixed(3) : '1'
      edgeOut.push(`<g opacity="${(e.a ?? 1).toFixed(3)}"${dimAttr(e.from, e.to)}><path d="${roundRoute(e.pts)}" class="m-edge ${edgeClass(e.style)}"${drawing}${arrow}/>${e.labels.map(l => `<text x="${l.x}" y="${l.y}" text-anchor="middle" class="m-elabel" opacity="${labelA}">${esc(cutText(l.text.toUpperCase(), 24))}</text>`).join('')}</g>`)
    }
  } else {
    // Unrouted (your arrangement, or no ELK): right-angled lines routed around
    // every box in the way (map-route.js), the parts' own links included.
    const shown = r => r && r.a >= 0.5
    const owner = id => (id.includes('/') ? id.slice(0, id.indexOf('/')) : null)
    // What a line between ends `f` and `t` must go around: every other
    // component, and the other parts inside a component it starts or ends in.
    // An open component it starts or ends in is no obstacle, apart from its
    // name and subtitle: lines come in below or beside them.
    const avoidFor = (f, t) => {
      const homes = new Set([f, t, owner(f), owner(t)].filter(Boolean))
      const boxes = mapData.nodes.filter(n => !homes.has(n.id) && shown(L.nodes[n.id])).map(n => L.nodes[n.id])
      for (const [k, r] of Object.entries(L.parts)) if (homes.has(owner(k)) && k !== f && k !== t && shown(r)) boxes.push(r)
      for (const n of mapData.nodes) {
        const r = L.nodes[n.id]
        if (!(n.id === owner(f) || n.id === owner(t)) || !shown(r)) continue
        const tx = nodeText(n, true)
        const textW = 28 + Math.max(...tx.label.map(x => x.length * CH.label), ...tx.sub.map(x => x.length * CH.sub), 0)
        boxes.push({ x: r.x, y: r.y, w: Math.min(r.w, textW), h: tx.head })
      }
      return boxes
    }
    const links = []
    for (const n of mapData.nodes) {
      if (!openSet.has(n.id)) continue
      const ids = new Set(partsFor(n).parts.map(p => p.id))
      for (const x of partsFor(n).edges) {
        const f = `${n.id}/${x.from}`; const t = `${n.id}/${x.to}`
        const a = L.parts[f]; const b = L.parts[t]
        if (!ids.has(x.from) || !ids.has(x.to) || x.from === x.to || !shown(a) || !shown(b)) continue
        links.push({ key: `${f}->${t}`, a, b, label: x.label, cls: '', mk: 'muted', limit: 22 })
      }
    }
    for (const x of linkEnds()) {
      const a = L.nodes[x.from] ?? L.parts[x.from]; const b = L.nodes[x.to] ?? L.parts[x.to]
      if (!shown(a) || !shown(b) || x.from === x.to) continue
      links.push({ key: `${x.from}->${x.to}`, a, b, label: x.label, cls: edgeClass(x.style), mk: marker(x.style), limit: 22 })
    }
    for (const l of links) {
      const [f, t] = l.key.split('->')
      l.avoid = avoidFor(f, t)
      // Parts sit close together: lines to and from them keep less room.
      if (owner(f) || owner(t)) l.gap = 10
      const off = L.isCustom && bendsOf()[l.key]
      if (off) { l.off = off; l.via = bendHandle(l.a, l.b, off) }
    }
    // The router is an ES module (map-route.js); until it has loaded, one elbow each.
    const routes = typeof routeLinks === 'function' ? routeLinks(links) : Object.fromEntries(links.map(l => {
      const pts = [centerOf(l.a), { x: centerOf(l.b).x, y: centerOf(l.a).y }, centerOf(l.b)]
      return [l.key, { pts, mx: pts[1].x, my: pts[1].y, isUpright: false }]
    }))
    for (const l of links) {
      const p = routes[l.key]
      const label = !l.label ? '' : p.isUpright
        ? `<text x="${p.mx + 8}" y="${p.my + 4}" text-anchor="start" class="m-elabel">${esc(cutText(l.label.toUpperCase(), l.limit))}</text>`
        : `<text x="${p.mx}" y="${p.my - (canBend(L) ? 11 : 5)}" text-anchor="middle" class="m-elabel">${esc(cutText(l.label.toUpperCase(), l.limit))}</text>`
      const [lf, lt] = l.key.split('->')
      edgeOut.push(`<g${dimAttr(lf, lt)}><path d="${roundRoute(p.pts)}" class="m-edge ${l.cls}" marker-end="url(#m-${l.mk})"/>${label}</g>`)
      if (!isExport && canBend(L)) handleOut.push({ key: l.key, ...(l.off ? { ...l.via, isBent: true } : midHandle(l.a, l.b, p)) })
    }
  }
  // Components first, then every line above their fills, then the parts.
  const partOut = []
  for (const n of mapData.nodes) {
    const r = L.nodes[n.id]
    if (!r) continue
    const isOpen = openSet.has(n.id)
    const t = nodeText(n, isOpen)
    const pv = partsFor(n)
    const isFocus = (mapData.focus ?? []).includes(n.id)
    const mark = mapData.marks?.[n.id]
    const isDim = lit && !lit.nodes.has(n.id)
    const ov = isExport ? null : overlayOf(n.id)
    out.push(`<g class="m-node${isOpen ? ' open' : ''}${isDim ? ' dim' : ''}${mapFocus.path?.ids?.includes(n.id) ? ' picked' : ''}" data-mnode="${esc(n.id)}" opacity="${r.a.toFixed(3)}"><title>${esc(n.label)}${n.sublabel ? ` · ${esc(n.sublabel)}` : ''}</title>`)
    out.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${isOpen ? 14 : 9}" class="m-box${isFocus ? ' focus' : ''}${!isExport && drawer?.id === n.id ? ' sel' : ''}"/>`)
    const pickAt = isExport ? -1 : (mapFocus.path?.ids ?? []).indexOf(n.id)
    if (pickAt >= 0) out.push(`<text x="${r.x + r.w}" y="${r.y - 7}" text-anchor="end" class="m-pick">${pickAt === 0 ? 'FROM' : 'TO'}</text>`)
    if (ov) out.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${isOpen ? 14 : 9}" class="m-ov ${ov.tone}" style="opacity:${ov.a.toFixed(2)}"/><text x="${r.x + r.w}" y="${r.y + r.h + 13}" text-anchor="end" class="m-ovtext">${esc(ov.text)}</text>`)
    out.push(`<text x="${r.x + 14}" y="${r.y + 20}" class="m-kind${isFocus ? ' focus' : ''}">${esc(n.kind.toUpperCase())}</text>`)
    out.push(mapLines(t.label, r.x + 14, r.y + 39, 18, 'm-label'))
    out.push(mapLines(t.sub, r.x + 14, r.y + 39 + t.label.length * 18 - 2, 14, 'm-sub'))
    if (isOpen && pv.isQuick && !isExport) out.push(`<text x="${r.x + 14}" y="${r.y + 37 + t.label.length * 18}" class="m-sub">${r.w > 420 ? 'quick look from its files · ' : 'quick look · '}<tspan class="m-cta" data-bd="${esc(n.id)}">✦ Break down with Claude</tspan></text>`)
    if (!isExport) out.push(`<text x="${r.x + r.w - 14}" y="${r.y + 21}" text-anchor="end" class="m-chev">${isOpen ? '−' : pv.parts.length ? `+${pv.parts.length}` : ''}</text>`)
    if (!isExport && (mapData.active ?? []).includes(n.id)) out.push(`<circle cx="${r.x + r.w - 10}" cy="${r.y + 10}" r="4" class="m-active"/>`)
    const drift = !isExport ? mapDrift.byNode?.[n.id] : null
    if (drift?.length) out.push(`<text x="${r.x + r.w - (isOpen ? 30 : 40)}" y="${r.y + 21}" text-anchor="end" class="m-warn" data-drifticon="1"><title>${esc(drift.map(i => (i.kind === 'missing' ? `${i.path} no longer exists` : `${i.files.length} file(s) changed since the breakdown`)).join(' · '))}</title>⚠</text>`)
    if (mark) out.push(`<text x="${r.x}" y="${r.y - 7}" class="m-mark" data-markof="${esc(n.id)}"><title>Marked: ${esc(plainText(mark))} (click to see and edit marks)</title>${esc(cutText(plainText(mark), 44))}</text>`)
    out.push('</g>')
    pv.parts.forEach((part, i) => {
      const pr = L.parts[`${n.id}/${part.id}`]
      if (!pr || pr.a < 0.02) return
      const pt = partText(part)
      const on = !isExport && drawer?.id === n.id && drawer?.part === part.id
      partOut.push(`<g class="m-part${isDim ? ' dim' : ''}" data-mpart="${esc(`${n.id}/${part.id}`)}" opacity="${pr.a.toFixed(3)}"><title>${esc(part.summary ?? part.label)}</title>
        <rect x="${pr.x}" y="${pr.y}" width="${pr.w}" height="${pr.h}" rx="8" class="m-pbox${on ? ' sel' : ''}"/>
        <text x="${pr.x + 32}" y="${pr.y + 19}" class="m-kind">${esc((part.role ?? (pv.isQuick ? 'files' : 'part')).toUpperCase())}</text>
        ${mapLines(pt.label, pr.x + 32, pr.y + 36, 16, 'm-plabel')}
        ${mapLines(pt.sub, pr.x + 32, pr.y + 36 + pt.label.length * 16 - 2, 13, 'm-sub')}
        <circle cx="${pr.x + 16}" cy="${pr.y + 16}" r="9" class="m-pin${part.detail ? ' done' : ''}"/>
        <text x="${pr.x + 16}" y="${pr.y + 19.5}" text-anchor="middle" class="m-pinnum${part.detail ? ' done' : ''}">${i + 1}</text></g>`)
    })
  }
  // Unlocked in your arrangement: a handle on every line, to bend it.
  const handles = handleOut.map(h => `<circle cx="${h.x}" cy="${h.y}" r="${h.isBent ? 6 : 5}" class="m-bend${h.isBent ? ' bent' : ''}" data-bend="${esc(h.key)}"><title>${h.isBent ? 'Drag to move this bend · double-click to straighten' : 'Drag to bend this line'}</title></circle>`)
  return out.join('') + edgeOut.join('') + partOut.join('') + handles.join('')
}

window.addEventListener('arch-live:routes', () => { if (mapLayout && !mapLayout.routed) drawMap(mapLayout) })
const drawMap = L => {
  if (!mapData) return
  // A view that went bad (a zero, negative or missing zoom) is reset, not drawn.
  if (!(mapView.z > 0) || !Number.isFinite(mapView.x) || !Number.isFinite(mapView.y)) Object.assign(mapView, fitView(L) ?? { x: 0, y: 0, z: 1 })
  $('#mapvp').innerHTML = mapMarkup(L)
  $('#mapvp').setAttribute('transform', `translate(${mapView.x},${mapView.y}) scale(${mapView.z})`)
  $('#mapZoom').textContent = `${Math.round(mapView.z * 100)}%`
}

// Animate to the layout as it should be now, keeping `anchorId` where it was
// on screen and, when it just opened, bringing it fully into view.
const animateMap = async (anchorId, ms = 460) => {
  const ticket = ++mapTicket
  const next = await computeLayout()
  if (ticket !== mapTicket) return
  const from = mapLayout ?? next
  const view0 = { x: mapView.x, y: mapView.y }
  const z0 = mapView.z > 0 ? mapView.z : 1
  const a0 = anchorId && from.nodes[anchorId]; const a1 = anchorId && next.nodes[anchorId]
  let z1 = z0
  let x1 = a0 && a1 ? view0.x + (a0.x - a1.x) * z0 : view0.x
  let y1 = a0 && a1 ? view0.y + (a0.y - a1.y) * z0 : view0.y
  const view = $('#map').getBoundingClientRect()
  const MG = 24
  // Fitting an opened component needs a laid-out canvas: one measured while
  // hidden or mid-resize is a few pixels wide, and fitting to that gave a
  // zero or negative zoom that hid the map from then on.
  if (a1 && openSet.has(anchorId) && view.width > MG * 4 && view.height > MG * 4) {
    z1 = Math.max(0.25, Math.min(z0, (view.width - MG * 2) / a1.w, (view.height - MG * 2) / a1.h))
    const sx = a0 ? view0.x + a0.x * z0 : x1 + a1.x * z1
    const sy = a0 ? view0.y + a0.y * z0 : y1 + a1.y * z1
    x1 = Math.min(Math.max(sx, MG), view.width - MG - a1.w * z1) - a1.x * z1
    y1 = Math.min(Math.max(sy, MG), view.height - MG - a1.h * z1) - a1.y * z1
  }
  cancelAnimationFrame(mapAnim)
  const t0 = performance.now()
  const step = now => {
    const t = Math.min(1, (now - t0) / ms)
    const k = ease(t)
    mapLayout = t < 1 ? between(from, next, t) : next
    mapView.x = mix(view0.x, x1, k); mapView.y = mix(view0.y, y1, k); mapView.z = mix(z0, z1, k)
    drawMap(mapLayout)
    if (t < 1) mapAnim = requestAnimationFrame(step)
  }
  mapAnim = requestAnimationFrame(step)
}

// The view that shows a whole layout, centred; null before there is room.
const fitView = L => {
  const r = $('#map').getBoundingClientRect()
  if (!L.w || !r.width) return null
  const z = Math.min(1.4, Math.max(0.25, Math.min((r.width - 40) / L.w, (r.height - 40) / L.h)))
  return { z, x: (r.width - L.w * z) / 2 - (L.minX ?? 0) * z, y: (r.height - L.h * z) / 2 - (L.minY ?? 0) * z }
}

const fitMap = async () => {
  const L = await computeLayout()
  const v = fitView(L)
  if (!v) return
  Object.assign(mapView, v)
  mapLayout = L
  drawMap(L)
}

// A big change builds up instead of morphing at once. First what stays glides
// into place and what went fades out; then the new components come in tier by
// tier (clients first, external services last), each rising into place, and
// each new line draws itself once both its ends are there.
const BUILD = { MORPH: 460, TIER: 360, NODE: 90, FADE: 320, DRAW: 380, RISE: 14 }
const isBigChange = (prevIds, nodes) => {
  const added = nodes.filter(n => !prevIds.has(n.id)).length
  return added >= 3 || (prevIds.size === 0 && added > 0)
}
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

const buildMap = async prevIds => {
  const ticket = ++mapTicket
  const next = await computeLayout()
  if (ticket !== mapTicket) return
  const comp = key => String(key ?? '').split('/')[0]
  const isNew = id => !prevIds.has(id)
  const clamp = v => Math.min(1, Math.max(0, v))
  const kindOf = Object.fromEntries(mapData.nodes.map(n => [n.id, n.kind]))
  // The map as it ends, less what is new: what the first phase glides to.
  const kept = { ...next, nodes: {}, parts: {}, edges: next.edges.filter(e => !isNew(comp(e.from)) && !isNew(comp(e.to))) }
  for (const [id, r] of Object.entries(next.nodes)) if (!isNew(id)) kept.nodes[id] = r
  for (const [key, r] of Object.entries(next.parts)) if (!isNew(comp(key))) kept.parts[key] = r
  // When each new component starts to show: tier by tier, then along the flow.
  const fresh = Object.keys(next.nodes)
    .filter(isNew)
    .map(id => ({ id, tier: TIER[kindOf[id]] ?? 2, r: next.nodes[id] }))
    .sort((a, b) => a.tier - b.tier || a.r.x - b.r.x || a.r.y - b.r.y)
  const startOf = {}
  let group = -1
  let tier = null
  let inGroup = 0
  for (const f of fresh) {
    if (f.tier !== tier) { group += 1; tier = f.tier; inGroup = 0 }
    startOf[f.id] = group * BUILD.TIER + inGroup++ * BUILD.NODE
  }
  const shownAt = id => (isNew(id) ? (startOf[id] ?? 0) + BUILD.FADE : 0)
  const isFreshEdge = e => isNew(comp(e.from)) || isNew(comp(e.to))
  const edgeStart = e => Math.max(shownAt(comp(e.from)), shownAt(comp(e.to)))
  const build = Math.max(0, ...fresh.map(f => startOf[f.id] + BUILD.FADE), ...next.edges.filter(isFreshEdge).map(e => edgeStart(e) + BUILD.DRAW))
  const frameAt = t => {
    const L = { ...next, nodes: { ...next.nodes }, parts: { ...next.parts }, edges: [] }
    const shown = id => ease(clamp((t - startOf[id]) / BUILD.FADE))
    for (const f of fresh) {
      const a = shown(f.id)
      L.nodes[f.id] = { ...f.r, y: f.r.y + (1 - a) * BUILD.RISE, a }
    }
    for (const [key, r] of Object.entries(next.parts)) {
      if (!isNew(comp(key))) continue
      const a = shown(comp(key))
      L.parts[key] = { ...r, y: r.y + (1 - a) * BUILD.RISE, a }
    }
    for (const e of next.edges) {
      if (!isFreshEdge(e)) { L.edges.push(e); continue }
      const p = clamp((t - edgeStart(e)) / BUILD.DRAW)
      if (p > 0) L.edges.push({ ...e, a: 1, draw: ease(p) })
    }
    return L
  }
  // Mostly new (a first map, a re-map): the view moves to frame the finished
  // map while what stays glides, so the build happens in view.
  const from = mapLayout ?? kept
  const hasKept = Object.keys(kept.nodes).length > 0 && !!mapLayout
  const morph = hasKept ? BUILD.MORPH : 0
  const view0 = { x: mapView.x, y: mapView.y, z: mapView.z }
  const view1 = fresh.length > Object.keys(kept.nodes).length ? (fitView(next) ?? view0) : view0
  cancelAnimationFrame(mapAnim)
  const t0 = performance.now()
  const step = now => {
    if (ticket !== mapTicket) return
    const t = now - t0
    const k = morph ? ease(clamp(t / morph)) : 1
    mapView.x = mix(view0.x, view1.x, k); mapView.y = mix(view0.y, view1.y, k); mapView.z = mix(view0.z, view1.z, k)
    if (t < morph) mapLayout = between(from, kept, t / morph)
    else mapLayout = t - morph >= build ? next : frameAt(t - morph)
    drawMap(mapLayout)
    if (t < morph + build) mapAnim = requestAnimationFrame(step)
  }
  mapAnim = requestAnimationFrame(step)
}

const loadInsights = async () => {
  const next = await api('/api/insights').catch(() => null)
  if (!next || next.error) return
  mapInsights = next
  if (mapLayout && mapPrefs.overlay !== 'none') drawMap(mapLayout)
}

const renderDiagram = async () => {
  const next = await api('/api/graph')
  if (next.error) return
  // What was on the map before this change, to tell a big change from a small one.
  const prevIds = mapData && mapView.isFitted ? new Set(mapData.nodes.map(n => n.id)) : null
  mapData = next
  loadDrift()
  loadInsights()
  // Opened or closed in the pane: take that over.
  const shared = next.view?.open
  if (Array.isArray(shared) && (shared.length !== openSet.size || shared.some(id => !openSet.has(id)))) {
    openSet.clear()
    for (const id of shared) openSet.add(id)
    keepOpen()
  }
  for (const id of [...openSet]) if (!mapData.nodes.some(n => n.id === id)) openSet.delete(id)
  if (!mapView.isFitted) { mapView.isFitted = true; return fitMap() }
  if (prevIds && isBigChange(prevIds, mapData.nodes) && !reducedMotion.matches) return buildMap(prevIds)
  animateMap(drawer?.id)
}

const toggleNode = id => {
  if (openSet.has(id)) openSet.delete(id)
  else openSet.add(id)
  saveOpen()
  animateMap(id)
}
const setAllOpen = async isOpen => {
  openSet.clear()
  if (isOpen) for (const n of mapData?.nodes ?? []) openSet.add(n.id)
  saveOpen()
  await animateMap(null, 520)
  setTimeout(fitMap, 560)
}

$('#map').addEventListener('click', async e => {
  if (mapDragged) { mapDragged = false; return }
  const bd = e.target.closest('[data-bd]')
  if (bd) {
    const res = await api('/api/ask', { kind: 'breakdown', component: bd.dataset.bd })
    return toast(res.ok ? 'Asked Claude to break this component down: it fills in here when done' : 'Could not reach the session')
  }
  const part = e.target.closest('[data-mpart]')
  if (part) {
    const key = part.dataset.mpart
    const nid = key.slice(0, key.indexOf('/')); const pid = key.slice(key.indexOf('/') + 1)
    if (drawer?.id !== nid) await openDrawer(nid)
    drawer.part = drawer.part === pid ? null : pid
    renderDrawer(); drawMap(mapLayout)
    $('#drawer').scrollTop = 0
    return
  }
  const markOf = e.target.closest('[data-markof]')
  if (markOf) {
    if (drawer?.id !== markOf.dataset.markof) await openDrawer(markOf.dataset.markof)
    $('#drawerMarks')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return
  }
  const node = e.target.closest('[data-mnode]')
  // Picking a path: the next component clicked (or any shift-click) is its other end.
  if (node && (e.shiftKey || mapFocus.path?.ids?.length === 1)) return pickForPath(node.dataset.mnode)
  if (node) {
    const id = node.dataset.mnode
    if (e.altKey) {
      return markComponent(id)
    }
    // The drawer opens first, so the canvas is measured at its new width.
    if (drawer?.id !== id) await openDrawer(id)
    else { drawer.part = null; renderDrawer() }
    toggleNode(id)
    return
  }
  if (mapFocus.path) return clearPath()
  if (drawer) closeDrawer()
})

// Shift-click one component, then another: the path between them stays lit.
// The bar at the top of the map says what is picked and how to get out.
const renderFocusBar = () => {
  const bar = $('#mapFocusBar')
  const p = mapFocus.path
  if (!p?.ids?.length) { bar.hidden = true; bar.innerHTML = ''; return }
  const name = id => `<strong>${esc(label(id))}</strong>`
  const text = p.ids.length === 1
    ? `Path from ${name(p.ids[0])}: now click the component it should reach`
    : p.chain ? `Path: ${p.chain.map(name).join(' → ')}` : `No connection between ${name(p.ids[0])} and ${name(p.ids[1])}`
  bar.innerHTML = `<span>${text}</span><button class="btn" data-focus="clear">${p.ids.length === 1 ? 'Cancel' : 'Clear path'} <kbd>Esc</kbd></button>`
  bar.hidden = false
}
const clearPath = () => { mapFocus.path = null; renderFocusBar(); if (mapLayout) drawMap(mapLayout) }
const pickForPath = id => {
  const ids = !mapFocus.path || mapFocus.path.ids.length === 2 ? [id] : mapFocus.path.ids[0] === id ? [] : [mapFocus.path.ids[0], id]
  if (!ids.length) return clearPath()
  const chain = ids.length === 2 ? pathBetween(ids[0], ids[1]) : null
  mapFocus.path = { ids, chain }
  renderFocusBar()
  drawMap(mapLayout)
}
// From the drawer's "Path to…": start a fresh path at this component, with
// the drawer closed and the whole map in view so the other end can be clicked.
const startPathFrom = async id => {
  mapFocus.path = null
  if (tab !== 'diagram') await setTab('diagram')
  if (drawer) closeDrawer()
  await fitMap()
  pickForPath(id)
}
// Reset view: no path, no drawer, the whole map in view (overlay and layout stay).
const resetMapView = async () => {
  mapFocus.path = null
  mapFocus.hover = null
  renderFocusBar()
  if (drawer) closeDrawer()
  await fitMap()
}
$('#mapReset').addEventListener('click', resetMapView)
$('#mapFocusBar').addEventListener('click', e => { if (e.target.closest('[data-focus="clear"]')) clearPath() })
// Hover: what a component touches stays, the rest fades (not while dragging).
$('#map').addEventListener('pointerover', e => {
  if (e.buttons) return
  const id = e.target.closest('[data-mnode]')?.dataset.mnode ?? null
  if (id === mapFocus.hover) return
  mapFocus.hover = id
  if (mapLayout && !mapFocus.path) drawMap(mapLayout)
})
$('#map').addEventListener('pointerleave', () => { if (mapFocus.hover) { mapFocus.hover = null; if (mapLayout && !mapFocus.path) drawMap(mapLayout) } })

// The overlay picker: what the boxes are tinted by.
const setOverlay = value => {
  mapPrefs.overlay = OVERLAYS[value] ? value : 'none'
  savePrefs()
  $('#mapOverlay').value = mapPrefs.overlay
  $('#mapLegend').textContent = OVERLAYS[mapPrefs.overlay].legend
  if (mapLayout) drawMap(mapLayout)
}
$('#mapOverlay').addEventListener('change', e => setOverlay(e.target.value))
$('#map').addEventListener('dblclick', e => {
  const part = e.target.closest('[data-mpart]')
  if (!part) return
  const key = part.dataset.mpart
  const n = mapData.nodes.find(x => x.id === key.slice(0, key.indexOf('/')))
  const p = partsFor(n).parts.find(x => x.id === key.slice(key.indexOf('/') + 1))
  if (p?.path) openCode(p.path, p.line)
})
// Drag the background to pan; scroll to pan, pinch or ⌘-scroll to zoom.
// Unlocked, a component can be dragged; the first drag starts your own
// arrangement from the layout on screen. A press without movement is a click.
const startNodeDrag = (e, id) => {
  const map = $('#map')
  const sx = e.clientX; const sy = e.clientY
  const b0 = { ...mapLayout.nodes[id] }
  const parts0 = Object.entries(mapLayout.parts).filter(([k]) => k.startsWith(`${id}/`)).map(([k, r]) => [k, { ...r }])
  let isMoving = false
  map.setPointerCapture(e.pointerId)
  const move = ev => {
    const dx = (ev.clientX - sx) / mapView.z; const dy = (ev.clientY - sy) / mapView.z
    if (!isMoving && Math.hypot(dx, dy) * mapView.z < 4) return
    if (!isMoving) {
      isMoving = true
      mapDragged = true
      map.classList.add('dragging')
      if (mapPrefs.mode !== 'custom') {
        // Start from what is on screen, every component where it stands.
        mapData.arrangement = { ...(mapData.arrangement ?? {}), positions: Object.fromEntries(Object.entries(mapLayout.nodes).map(([k, r]) => [k, { x: r.x, y: r.y }])) }
        mapPrefs.mode = 'custom'; savePrefs(); syncMapTools()
      }
      mapLayout = { ...mapLayout, routed: false, edges: [], tiers: [], isCustom: true }
    }
    const snap = v => Math.round(v / 8) * 8
    mapLayout.nodes[id] = { ...b0, x: snap(b0.x + dx), y: snap(b0.y + dy) }
    const ox = mapLayout.nodes[id].x - b0.x; const oy = mapLayout.nodes[id].y - b0.y
    for (const [k, r] of parts0) mapLayout.parts[k] = { ...r, x: r.x + ox, y: r.y + oy }
    drawMap(mapLayout)
  }
  const up = () => {
    map.classList.remove('dragging')
    map.removeEventListener('pointermove', move); map.removeEventListener('pointerup', up)
    if (isMoving) {
      const positions = { ...(mapData.arrangement?.positions ?? {}), [id]: { x: mapLayout.nodes[id].x, y: mapLayout.nodes[id].y } }
      mapData.arrangement = { ...(mapData.arrangement ?? {}), positions }
      saveArrangement()
    }
    setTimeout(() => { mapDragged = false }, 0)
  }
  map.addEventListener('pointermove', move); map.addEventListener('pointerup', up)
}

// Dragging a line's handle bends it; double-clicking it straightens it.
const saveArrangement = () => api('/api/arrangement', { positions: mapData.arrangement?.positions ?? {}, bends: mapData.arrangement?.bends ?? {} })
const toMapPoint = ev => {
  const r = $('#map').getBoundingClientRect()
  return { x: (ev.clientX - r.left - mapView.x) / mapView.z, y: (ev.clientY - r.top - mapView.y) / mapView.z }
}
const endsOfKey = key => {
  const [from, to] = key.split('->')
  return [mapLayout.nodes[from] ?? mapLayout.parts[from], mapLayout.nodes[to] ?? mapLayout.parts[to]]
}
const startBendDrag = (e, key) => {
  const map = $('#map')
  map.setPointerCapture(e.pointerId)
  mapDragged = true
  map.classList.add('dragging')
  const move = ev => {
    const [ra, rb] = endsOfKey(key)
    if (!ra || !rb) return
    const p = toMapPoint(ev)
    const a = centerOf(ra); const b = centerOf(rb)
    mapData.arrangement = { ...(mapData.arrangement ?? {}), bends: { ...bendsOf(), [key]: { dx: p.x - (a.x + b.x) / 2, dy: p.y - (a.y + b.y) / 2 } } }
    drawMap(mapLayout)
  }
  const up = () => {
    map.classList.remove('dragging')
    map.removeEventListener('pointermove', move); map.removeEventListener('pointerup', up)
    saveArrangement()
    setTimeout(() => { mapDragged = false }, 0)
  }
  map.addEventListener('pointermove', move); map.addEventListener('pointerup', up)
}
$('#map').addEventListener('dblclick', e => {
  const h = e.target.closest('[data-bend]')
  if (!h || !bendsOf()[h.dataset.bend]) return
  const { [h.dataset.bend]: _gone, ...rest } = bendsOf()
  mapData.arrangement = { ...(mapData.arrangement ?? {}), bends: rest }
  drawMap(mapLayout)
  saveArrangement()
})

$('#map').addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  const bend = e.target.closest('[data-bend]')
  if (bend && !mapPrefs.isLocked) return startBendDrag(e, bend.dataset.bend)
  const dragNode = !mapPrefs.isLocked && !e.target.closest('[data-mpart], [data-bd], [data-markof]') && e.target.closest('[data-mnode]')
  if (dragNode && mapLayout?.nodes[dragNode.dataset.mnode]) return startNodeDrag(e, dragNode.dataset.mnode)
  if (e.target.closest('[data-mnode], [data-mpart]')) return
  const sx = e.clientX; const sy = e.clientY; const vx = mapView.x; const vy = mapView.y
  const map = $('#map')
  map.setPointerCapture(e.pointerId)
  map.classList.add('panning')
  const move = ev => {
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) mapDragged = true
    mapView.x = vx + ev.clientX - sx; mapView.y = vy + ev.clientY - sy
    drawMap(mapLayout)
  }
  const up = () => { map.classList.remove('panning'); map.removeEventListener('pointermove', move); map.removeEventListener('pointerup', up); setTimeout(() => { mapDragged = false }, 0) }
  map.addEventListener('pointermove', move); map.addEventListener('pointerup', up)
})
const zoomMap = (f, px, py) => {
  const z = Math.min(2.5, Math.max(0.2, mapView.z * f))
  mapView.x = px - (px - mapView.x) * (z / mapView.z); mapView.y = py - (py - mapView.y) * (z / mapView.z); mapView.z = z
  drawMap(mapLayout)
}
$('#map').addEventListener('wheel', e => {
  e.preventDefault()
  const r = $('#map').getBoundingClientRect()
  if (e.ctrlKey || e.metaKey) zoomMap(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
  else { mapView.x -= e.deltaX; mapView.y -= e.deltaY; drawMap(mapLayout) }
}, { passive: false })
const syncMapTools = () => {
  $('#mapMode').value = mapPrefs.mode
  $('#mapOverlay').value = mapPrefs.overlay
  $('#mapLegend').textContent = OVERLAYS[mapPrefs.overlay]?.legend ?? ''
  $('#mapLock').textContent = mapPrefs.isLocked ? '🔒 Locked' : '🔓 Drag to arrange'
  $('#mapLock').classList.toggle('unlocked', !mapPrefs.isLocked)
  $('#map').classList.toggle('unlocked', !mapPrefs.isLocked)
}
$('#mapMode').addEventListener('change', async e => {
  mapPrefs.mode = e.target.value
  savePrefs(); syncMapTools()
  await animateMap(null, 520)
  setTimeout(fitMap, 560)
})
$('#mapLock').addEventListener('click', () => {
  mapPrefs.isLocked = !mapPrefs.isLocked
  savePrefs(); syncMapTools()
  if (mapLayout) drawMap(mapLayout)
  toast(mapPrefs.isLocked ? 'Locked: components and lines stay where they are' : mapPrefs.mode === 'custom' ? 'Unlocked: drag components, or a line\'s handle to bend it' : 'Unlocked: drag a component to arrange the map your way')
})
syncMapTools()
$('#mapExpand').addEventListener('click', () => setAllOpen(true))
$('#mapCollapse').addEventListener('click', () => setAllOpen(false))
$('#mapFit').addEventListener('click', fitMap)
$('#mapIn').addEventListener('click', () => { const r = $('#map').getBoundingClientRect(); zoomMap(1.2, r.width / 2, r.height / 2) })
$('#mapOut').addEventListener('click', () => { const r = $('#map').getBoundingClientRect(); zoomMap(1 / 1.2, r.width / 2, r.height / 2) })

// The map check: where the map no longer matches the code.
let mapDrift = { issues: [], byNode: {} }
const loadDrift = async () => {
  const d = await api('/api/drift')
  if (d.error) return
  const byNode = {}
  for (const i of d.issues) if (i.node) (byNode[i.node] ??= []).push(i)
  mapDrift = { ...d, byNode }
  const n = d.issues.length
  $('#driftBtn').hidden = !n
  $('#driftBtn').textContent = `⚠ Map may be out of date (${n})`
  $('#driftMenu').innerHTML = d.issues.map(i => {
    if (i.kind === 'missing') return `<div class="issue"><b>${esc(i.label)}</b>: <code>${esc(i.path)}</code> no longer exists.<div class="acts"><button class="btn tiny" data-drift-remap>Re-map with Claude</button></div></div>`
    if (i.kind === 'breakdown') return `<div class="issue"><b>${esc(i.label)}</b>: ${i.files.length} file${i.files.length === 1 ? '' : 's'} changed since its breakdown (${i.files.slice(0, 3).map(f => `<code>${esc(f.split('/').pop())}</code>`).join(', ')}${i.files.length > 3 ? '…' : ''}).<div class="acts"><button class="btn tiny" data-drift-breakdown="${esc(i.node)}">Break down again</button></div></div>`
    return `<div class="issue"><code>${esc(i.folder)}/</code> (${i.files} files) is not part of any component.<div class="acts"><button class="btn tiny" data-drift-remap>Re-map with Claude</button><button class="btn tiny" data-drift-ignore="${esc(i.folder)}">Ignore this folder</button></div></div>`
  }).join('') + (n ? '<div class="issue"><button class="btn tiny accent" data-drift-remap>Re-map the whole project with Claude</button></div>' : '')
  if (mapLayout) drawMap(mapLayout)
}
$('#driftBtn').addEventListener('click', e => { e.stopPropagation(); $('#driftMenu').hidden = !$('#driftMenu').hidden })
document.addEventListener('click', e => { if (!e.target.closest('#driftMenu, #driftBtn')) $('#driftMenu').hidden = true })
$('#driftMenu').addEventListener('click', async e => {
  const t = e.target
  if (t.closest('[data-drift-remap]')) {
    $('#driftMenu').hidden = true
    const res = await api('/api/ask', { kind: 'map' })
    return toast(res.ok ? 'Asked Claude to re-map the project: the map redraws when it is done' : 'Could not reach the session')
  }
  const bd = t.closest('[data-drift-breakdown]')
  if (bd) {
    $('#driftMenu').hidden = true
    const res = await api('/api/ask', { kind: 'breakdown', component: bd.dataset.driftBreakdown })
    return toast(res.ok ? 'Asked Claude to break it down again' : 'Could not reach the session')
  }
  const ig = t.closest('[data-drift-ignore]')
  if (ig) {
    const st = await api('/api/settings')
    await api('/api/settings', { ignoreFolders: [...st.project.ignoreFolders, ig.dataset.driftIgnore] })
    toast(`${ig.dataset.driftIgnore}/ ignored: undo it in Settings`)
    return loadDrift()
  }
})
