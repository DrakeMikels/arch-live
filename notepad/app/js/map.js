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
// The fallback's curve between two boxes.
const linkPath = (ra, rb) => {
  const cy = r => r.y + r.h / 2
  if (ra.x + ra.w <= rb.x || rb.x + rb.w <= ra.x) {
    const isRight = ra.x + ra.w <= rb.x
    const x1 = isRight ? ra.x + ra.w : ra.x
    const x2 = isRight ? rb.x : rb.x + rb.w
    const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (isRight ? 1 : -1)
    return { d: `M ${x1} ${cy(ra)} C ${x1 + dx} ${cy(ra)}, ${x2 - dx} ${cy(rb)}, ${x2} ${cy(rb)}`, mx: (x1 + x2) / 2, my: (cy(ra) + cy(rb)) / 2 }
  }
  const isDown = rb.y > ra.y
  const x1 = ra.x + ra.w / 2; const x2 = rb.x + rb.w / 2
  const y1 = isDown ? ra.y + ra.h : ra.y; const y2 = isDown ? rb.y : rb.y + rb.h
  return { d: `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
}
// A note's text without its formatting marks, for places that draw plain text.
const plainText = t => String(t ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/~~([^~]+)~~/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, '$1$2').replace(/^\s*[-*] /gm, '').replace(/\s*\n\s*/g, ' · ')
const cutText = (t, n) => (String(t ?? '').length > n ? `${String(t).slice(0, n - 1)}…` : String(t ?? ''))
// A line you bent in your arrangement: it leaves each box on the side facing
// the handle and passes through it. The handle is kept relative to the
// midpoint of the two boxes, so it follows them when they move.
const centerOf = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const faceToward = (r, p) => {
  const c = centerOf(r)
  const dx = p.x - c.x; const dy = p.y - c.y
  if (Math.abs(dx) / r.w > Math.abs(dy) / r.h) return { x: dx > 0 ? r.x + r.w : r.x, y: c.y }
  return { x: c.x, y: dy > 0 ? r.y + r.h : r.y }
}
const bendHandle = (ra, rb, off) => {
  const a = centerOf(ra); const b = centerOf(rb)
  return { x: (a.x + b.x) / 2 + off.dx, y: (a.y + b.y) / 2 + off.dy }
}
const bentPath = (ra, rb, off) => {
  const h = bendHandle(ra, rb, off)
  const p1 = faceToward(ra, h); const p2 = faceToward(rb, h)
  const cx = 2 * h.x - (p1.x + p2.x) / 2; const cy = 2 * h.y - (p1.y + p2.y) / 2
  return { d: `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`, mx: h.x, my: h.y }
}
const bendsOf = () => mapData?.arrangement?.bends ?? {}
const canBend = L => L.isCustom && !mapPrefs.isLocked
// The handle of an unbent line: the curve's middle, where a drag starts from.
const midHandle = (ra, rb, p) => ({ x: p.mx, y: p.my, dx: p.mx - (centerOf(ra).x + centerOf(rb).x) / 2, dy: p.my - (centerOf(ra).y + centerOf(rb).y) / 2 })

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
  if (L.routed) {
    for (const e of L.edges) {
      if (e.a <= 0.01) continue
      edgeOut.push(`<g opacity="${(e.a ?? 1).toFixed(3)}"><path d="${roundRoute(e.pts)}" class="m-edge ${edgeClass(e.style)}" marker-end="url(#m-${marker(e.style)})"/>${e.labels.map(l => `<text x="${l.x}" y="${l.y}" text-anchor="middle" class="m-elabel">${esc(cutText(l.text.toUpperCase(), 24))}</text>`).join('')}</g>`)
    }
  } else {
    // Unrouted (your arrangement, or no ELK): curves, the parts' own links included.
    for (const n of mapData.nodes) {
      if (!openSet.has(n.id)) continue
      const ids = new Set(partsFor(n).parts.map(p => p.id))
      for (const x of partsFor(n).edges) {
        const a = L.parts[`${n.id}/${x.from}`]; const b = L.parts[`${n.id}/${x.to}`]
        if (!ids.has(x.from) || !ids.has(x.to) || !a || !b || Math.min(a.a, b.a) < 0.5) continue
        const key = `${n.id}/${x.from}->${n.id}/${x.to}`
        const off = bendsOf()[key]
        const pth = off && L.isCustom ? bentPath(a, b, off) : linkPath(a, b)
        edgeOut.push(`<path d="${pth.d}" class="m-edge" marker-end="url(#m-muted)"/>${x.label ? `<text x="${pth.mx}" y="${pth.my - (canBend(L) ? 11 : 5)}" text-anchor="middle" class="m-elabel">${esc(cutText(x.label.toUpperCase(), 22))}</text>` : ''}`)
        if (!isExport && canBend(L)) handleOut.push({ key, ...(off ? { ...bendHandle(a, b, off), isBent: true } : midHandle(a, b, pth)) })
      }
    }
    for (const x of linkEnds()) {
      const ra = L.nodes[x.from] ?? L.parts[x.from]; const rb = L.nodes[x.to] ?? L.parts[x.to]
      if (!ra || !rb || Math.min(ra.a, rb.a) < 0.5) continue
      const key = `${x.from}->${x.to}`
      const off = bendsOf()[key]
      const p = off && L.isCustom ? bentPath(ra, rb, off) : linkPath(ra, rb)
      if (!isExport && canBend(L)) handleOut.push({ key, ...(off ? { ...bendHandle(ra, rb, off), isBent: true } : midHandle(ra, rb, p)) })
      edgeOut.push(`<path d="${p.d}" class="m-edge ${edgeClass(x.style)}" marker-end="url(#m-${marker(x.style)})"/>${x.label ? `<text x="${p.mx}" y="${p.my - (canBend(L) ? 11 : 5)}" text-anchor="middle" class="m-elabel">${esc(cutText(x.label.toUpperCase(), 22))}</text>` : ''}`)
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
    out.push(`<g class="m-node${isOpen ? ' open' : ''}" data-mnode="${esc(n.id)}" opacity="${r.a.toFixed(3)}"><title>${esc(n.label)}${n.sublabel ? ` · ${esc(n.sublabel)}` : ''}</title>`)
    out.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${isOpen ? 14 : 9}" class="m-box${isFocus ? ' focus' : ''}${!isExport && drawer?.id === n.id ? ' sel' : ''}"/>`)
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
      partOut.push(`<g class="m-part" data-mpart="${esc(`${n.id}/${part.id}`)}" opacity="${pr.a.toFixed(3)}"><title>${esc(part.summary ?? part.label)}</title>
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

const drawMap = L => {
  if (!mapData) return
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
  const z0 = mapView.z
  const a0 = anchorId && from.nodes[anchorId]; const a1 = anchorId && next.nodes[anchorId]
  let z1 = z0
  let x1 = a0 && a1 ? view0.x + (a0.x - a1.x) * z0 : view0.x
  let y1 = a0 && a1 ? view0.y + (a0.y - a1.y) * z0 : view0.y
  if (a1 && openSet.has(anchorId)) {
    const view = $('#map').getBoundingClientRect()
    const MG = 24
    z1 = Math.min(z0, (view.width - MG * 2) / a1.w, (view.height - MG * 2) / a1.h)
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

const fitMap = async () => {
  const L = await computeLayout()
  const r = $('#map').getBoundingClientRect()
  if (!L.w || !r.width) return
  mapView.z = Math.min(1.4, Math.max(0.25, Math.min((r.width - 40) / L.w, (r.height - 40) / L.h)))
  mapView.x = (r.width - L.w * mapView.z) / 2 - (L.minX ?? 0) * mapView.z
  mapView.y = (r.height - L.h * mapView.z) / 2 - (L.minY ?? 0) * mapView.z
  mapLayout = L
  drawMap(L)
}

const renderDiagram = async () => {
  const next = await api('/api/graph')
  if (next.error) return
  mapData = next
  loadDrift()
  for (const id of [...openSet]) if (!mapData.nodes.some(n => n.id === id)) openSet.delete(id)
  if (!mapView.isFitted) { mapView.isFitted = true; return fitMap() }
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
  if (drawer) closeDrawer()
})
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
