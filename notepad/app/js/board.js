/* ---------- Board ---------- */

const board = { id: null, title: 'Untitled board', items: [], underlay: false, session: null }
const view = { x: 80, y: 60, z: 1 }
let tool = 'select'
let color = 'ink'
let stroke = 2
let selection = new Set()
let history = []
let future = []
let underlaySvg = ''
let editing = null

const COLORS = [['ink', null], ['accent', null], ['link', null], ['muted', null], ['green', '#3f8f5f'], ['red', '#d9363e']]
const colorOf = name => COLORS.find(c => c[0] === name)?.[1] ?? (cssVar(name) || name)
const TOOLS = [
  ['select', 'V', '<path d="M5 3l11 6-5 1.5L9 16z" fill="currentColor"/>', 'Select and move'],
  ['hand', 'H', '<path d="M7 9V4.5a1.5 1.5 0 013 0V9m0-1V3.5a1.5 1.5 0 013 0V9m0-.5V5a1.5 1.5 0 013 0v6c0 3.5-2.5 6-6 6s-5.5-2-6.5-4L2.5 9.5a1.4 1.4 0 012.3-1.6L7 10.5" fill="none" stroke="currentColor" stroke-width="1.4"/>', 'Pan'],
  ['pen', 'P', '<path d="M3 17c2-1 3-4 5-6s4-3 5-5 2-3 3-3-1 2-2 4-3 4-5 6-4 3-6 4z" fill="currentColor"/>', 'Pen'],
  ['rect', 'R', '<rect x="3" y="5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>', 'Rectangle'],
  ['ellipse', 'O', '<ellipse cx="10" cy="10" rx="7" ry="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/>', 'Ellipse'],
  ['arrow', 'A', '<path d="M3 16L16 4M16 4h-6M16 4v6" fill="none" stroke="currentColor" stroke-width="1.6"/>', 'Arrow'],
  ['line', 'L', '<path d="M3 16L17 4" stroke="currentColor" stroke-width="1.6"/>', 'Line'],
  ['text', 'T', '<path d="M4 4h12M10 4v13" stroke="currentColor" stroke-width="1.8"/>', 'Text'],
  ['code', 'C', '<path d="M7 5L2 10l5 5M13 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6"/>', 'Code block'],
  ['sticky', 'N', '<path d="M3 3h14v9l-5 5H3z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 17v-5h5" fill="none" stroke="currentColor" stroke-width="1.6"/>', 'Sticky note'],
  ['eraser', 'E', '<path d="M8 17l-5-5 8-8 6 6-6 7zM6 17h11" fill="none" stroke="currentColor" stroke-width="1.6"/>', 'Eraser'],
]
const KEY_TOOL = Object.fromEntries(TOOLS.map(t => [t[1].toLowerCase(), t[0]]))
const uid = () => Math.random().toString(36).slice(2, 10)
const MONO = "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace"

const wrapLines = (text, width, size) => {
  const per = Math.max(4, Math.floor(width / (size * 0.6)))
  return String(text).split('\n').flatMap(line => {
    if (line.length <= per) return [line]
    const out = []
    let cur = ''
    for (const word of line.split(' ')) {
      if ((cur + ' ' + word).trim().length > per) { if (cur) out.push(cur); cur = word } else cur = (cur + ' ' + word).trim()
    }
    if (cur) out.push(cur)
    return out
  })
}

// Every item's box, in board units: the one rule for drawing, hit tests and handles.
const boxOf = it => {
  if (it.type === 'pen') {
    const xs = it.points.map(p => p[0]); const ys = it.points.map(p => p[1])
    const x = Math.min(...xs); const y = Math.min(...ys)
    return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) }
  }
  if (it.type === 'arrow' || it.type === 'line') {
    return { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), w: Math.max(1, Math.abs(it.x2 - it.x1)), h: Math.max(1, Math.abs(it.y2 - it.y1)) }
  }
  if (it.type === 'text') {
    const lines = String(it.text || ' ').split('\n')
    return { x: it.x, y: it.y, w: Math.max(...lines.map(l => l.length), 1) * it.size * 0.6, h: lines.length * it.size * 1.35 }
  }
  if (it.type === 'code') {
    const lines = String(it.text || ' ').split('\n')
    return { x: it.x, y: it.y, w: Math.max(160, Math.max(...lines.map(l => l.length)) * it.size * 0.6 + 28), h: lines.length * it.size * 1.45 + 40 }
  }
  if (it.type === 'sticky') {
    const lines = wrapLines(it.text || ' ', it.w - 24, it.size)
    return { x: it.x, y: it.y, w: it.w, h: Math.max(80, lines.length * it.size * 1.4 + 28) }
  }
  return { x: Math.min(it.x, it.x + it.w), y: Math.min(it.y, it.y + it.h), w: Math.abs(it.w), h: Math.abs(it.h) }
}

const smooth = pts => {
  if (pts.length < 3) return `M ${pts.map(p => p.join(',')).join(' L ')}`
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2; const my = (pts[i][1] + pts[i + 1][1]) / 2
    d += ` Q ${pts[i][0]},${pts[i][1]} ${mx},${my}`
  }
  const last = pts[pts.length - 1]
  return `${d} L ${last[0]},${last[1]}`
}

const tspans = (lines, x, y0, lh) => lines.map((l, i) => `<tspan x="${x}" y="${y0 + i * lh}">${esc(l) || ' '}</tspan>`).join('')

const itemSvg = it => {
  const c = colorOf(it.color)
  const hit = 'stroke="transparent" stroke-width="14" fill="none"'
  switch (it.type) {
    case 'pen': {
      const d = smooth(it.points)
      return `<g data-item="${it.id}"><path d="${d}" ${hit}/><path d="${d}" fill="none" stroke="${c}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"/></g>`
    }
    case 'rect': case 'ellipse': {
      const b = boxOf(it)
      const fill = it.fill ? `${c}22` : 'transparent'
      const shape = it.type === 'rect'
        ? `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${fill}" stroke="${c}" stroke-width="${it.width}"/>`
        : `<ellipse cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" fill="${fill}" stroke="${c}" stroke-width="${it.width}"/>`
      return `<g data-item="${it.id}">${shape}</g>`
    }
    case 'arrow': case 'line': {
      const line = `M ${it.x1},${it.y1} L ${it.x2},${it.y2}`
      let head = ''
      if (it.type === 'arrow') {
        const a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1); const s = 8 + it.width * 2
        const p1 = [it.x2 - s * Math.cos(a - 0.45), it.y2 - s * Math.sin(a - 0.45)]
        const p2 = [it.x2 - s * Math.cos(a + 0.45), it.y2 - s * Math.sin(a + 0.45)]
        head = `<path d="M ${p1} L ${it.x2},${it.y2} L ${p2}" fill="none" stroke="${c}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"/>`
      }
      return `<g data-item="${it.id}"><path d="${line}" ${hit}/><path d="${line}" stroke="${c}" stroke-width="${it.width}" stroke-linecap="round"/>${head}</g>`
    }
    case 'text': {
      const lines = String(it.text).split('\n')
      return `<g data-item="${it.id}"><rect x="${it.x}" y="${it.y}" width="${boxOf(it).w}" height="${boxOf(it).h}" fill="transparent"/><text font-family="${MONO}" font-size="${it.size}" fill="${c}">${tspans(lines, it.x, it.y + it.size, it.size * 1.35)}</text></g>`
    }
    case 'code': {
      const b = boxOf(it); const lines = String(it.text).split('\n')
      return `<g data-item="${it.id}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${cssVar('paper2')}" stroke="${cssVar('rule')}"/>` +
        `<text x="${b.x + 14}" y="${b.y + 17}" font-family="${MONO}" font-size="9" letter-spacing="1.5" fill="${cssVar('soft')}">${esc((it.lang || 'CODE').toUpperCase())}</text>` +
        `<text font-family="${MONO}" font-size="${it.size}" fill="${cssVar('ink')}">${tspans(lines, b.x + 14, b.y + 30 + it.size, it.size * 1.45)}</text></g>`
    }
    case 'sticky': {
      const b = boxOf(it); const lines = wrapLines(it.text, it.w - 24, it.size)
      return `<g data-item="${it.id}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4" fill="${c}26" stroke="${c}" stroke-width="1"/>` +
        `<text font-family="${MONO}" font-size="${it.size}" fill="${cssVar('ink')}">${tspans(lines, b.x + 12, b.y + 14 + it.size, it.size * 1.4)}</text></g>`
    }
  }
  return ''
}

const applyView = () => {
  $('#viewport').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.z})`)
  $('#zoomLabel').textContent = `${Math.round(view.z * 100)}%`
  $('#stage').style.backgroundSize = `${22 * view.z}px ${22 * view.z}px`
  $('#stage').style.backgroundPosition = `${view.x}px ${view.y}px`
}

const drawBoard = () => {
  $('#items').innerHTML = board.items.map(itemSvg).join('')
  $('#underlayLayer').innerHTML = board.underlay ? underlaySvg : ''
  const handles = []
  const k = 1 / view.z
  for (const id of selection) {
    const it = board.items.find(i => i.id === id)
    if (!it) continue
    const b = boxOf(it)
    handles.push(`<rect x="${b.x - 6 * k}" y="${b.y - 6 * k}" width="${b.w + 12 * k}" height="${b.h + 12 * k}" fill="none" stroke="${cssVar('accent')}" stroke-width="${k}" stroke-dasharray="${4 * k},${3 * k}"/>`)
    if (selection.size === 1) {
      const pts = it.type === 'arrow' || it.type === 'line'
        ? [['p1', it.x1, it.y1], ['p2', it.x2, it.y2]]
        : [['nw', b.x - 6 * k, b.y - 6 * k], ['ne', b.x + b.w + 6 * k, b.y - 6 * k], ['sw', b.x - 6 * k, b.y + b.h + 6 * k], ['se', b.x + b.w + 6 * k, b.y + b.h + 6 * k]]
      for (const [h, x, y] of pts) handles.push(`<rect data-handle="${h}" x="${x - 5 * k}" y="${y - 5 * k}" width="${10 * k}" height="${10 * k}" rx="${2 * k}" fill="${cssVar('nodeFill')}" stroke="${cssVar('accent')}" stroke-width="${1.5 * k}" style="cursor:${h === 'nw' || h === 'se' ? 'nwse' : h === 'ne' || h === 'sw' ? 'nesw' : 'move'}-resize"/>`)
    }
  }
  if (marquee) {
    const x = Math.min(marquee.x0, marquee.x1); const y = Math.min(marquee.y0, marquee.y1)
    handles.push(`<rect x="${x}" y="${y}" width="${Math.abs(marquee.x1 - marquee.x0)}" height="${Math.abs(marquee.y1 - marquee.y0)}" fill="${cssVar('accentTint')}" stroke="${cssVar('accent')}" stroke-width="${k}"/>`)
  }
  $('#overlay').innerHTML = handles.join('')
  applyView()
}

const renderTools = () => {
  $('#tools').innerHTML = TOOLS.map(([id, key, icon, name]) =>
    `<button data-tool="${id}" aria-pressed="${tool === id}" title="${name} (${key})"><svg width="20" height="20" viewBox="0 0 20 20">${icon}</svg><kbd>${key}</kbd></button>`).join('') +
    '<hr>' + COLORS.map(([name]) => `<button class="swatch" data-color="${name}" aria-pressed="${color === name}" title="${name}" style="background:${colorOf(name)}"></button>`).join('') +
    '<hr>' + [1, 2, 4].map(w => `<button data-stroke="${w}" aria-pressed="${stroke === w}" title="Stroke ${w}"><svg width="20" height="20"><line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" stroke-width="${w + 0.5}" stroke-linecap="round"/></svg></button>`).join('')
  const svg = $('#board')
  svg.style.cursor = tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : tool === 'eraser' ? 'cell' : 'crosshair'
}

const snapshot = () => { history.push(JSON.stringify(board.items)); if (history.length > 100) history.shift(); future = [] }
const undo = () => { if (!history.length) return; future.push(JSON.stringify(board.items)); board.items = JSON.parse(history.pop()); selection.clear(); drawBoard(); save() }
const redo = () => { if (!future.length) return; history.push(JSON.stringify(board.items)); board.items = JSON.parse(future.pop()); selection.clear(); drawBoard(); save() }

let saveTimer
const save = () => {
  clearTimeout(saveTimer)
  $('#saved').textContent = 'Saving…'
  saveTimer = setTimeout(async () => {
    if (!board.id) board.id = `board-${Date.now().toString(36)}`
    await api('/api/board', { id: board.id, title: board.title, items: board.items, underlay: board.underlay, session: board.session })
    $('#saved').textContent = `Saved ${time(Date.now())}`
    refreshBoardList()
  }, 600)
}

const refreshBoardList = async () => {
  const { boards } = await api('/api/boards')
  const list = board.id && !boards.some(b => b.id === board.id) ? [{ id: board.id, title: board.title, session: board.session }, ...boards] : boards
  // Grouped by session: this one first, then the others by latest board.
  const groups = new Map()
  for (const b of list) {
    const key = b.session ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(b)
  }
  const order = [...groups.keys()].sort((a, b) => (b === data?.self) - (a === data?.self))
  const option = b => `<option value="${esc(b.id)}" ${b.id === board.id ? 'selected' : ''}>${esc(b.title)}</option>`
  $('#boardList').innerHTML = list.length
    ? order.map(key => `<optgroup label="${esc(key === data?.self ? `This session · ${sessionName(key)}` : sessionName(key))}">${groups.get(key).map(option).join('')}</optgroup>`).join('')
    : '<option>No boards yet</option>'
  return boards
}

const loadBoard = async id => {
  const b = await api(`/api/board?id=${encodeURIComponent(id)}`)
  if (b.error) return
  Object.assign(board, { id: b.id, title: b.title, items: b.items ?? [], underlay: !!b.underlay, session: b.session ?? null })
  $('#boardTitle').value = board.title
  $('#underlay').checked = board.underlay
  selection.clear(); history = []; future = []
  if (board.underlay) await loadUnderlay()
  drawBoard()
  refreshBoardList()
}

const newBoard = () => {
  const named = data?.self && sessionById(data.self)?.name
  const date = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })
  Object.assign(board, { id: `board-${Date.now().toString(36)}`, title: named || `Board ${date}`, items: [], underlay: false, session: data?.self ?? null })
  $('#boardTitle').value = board.title
  $('#underlay').checked = false
  selection.clear(); history = []; future = []
  drawBoard(); save()
}

const loadUnderlay = async () => {
  const svg = await fetch(`/live.svg?t=${token}`).then(r => r.text())
  underlaySvg = `<g opacity="0.9">${svg.replace(/<svg /, '<svg x="0" y="0" ')}</g>`
}

// Pointer → board coordinates.
const toBoard = e => {
  const r = $('#board').getBoundingClientRect()
  return [(e.clientX - r.left - view.x) / view.z, (e.clientY - r.top - view.y) / view.z]
}

let drag = null
let marquee = null
let spaceHeld = false

const itemAt = e => document.elementFromPoint(e.clientX, e.clientY)?.closest('#items [data-item]')?.dataset.item

const startEdit = it => {
  const ta = document.createElement('textarea')
  ta.className = 'editor'
  ta.value = it.text
  const place = () => {
    const b = boxOf({ ...it, text: ta.value || ' ' })
    const r = $('#board').getBoundingClientRect(); const s = $('#stage').getBoundingClientRect()
    ta.style.left = `${r.left - s.left + view.x + b.x * view.z - 2}px`
    ta.style.top = `${r.top - s.top + view.y + b.y * view.z - 2}px`
    ta.style.width = `${Math.max(120, b.w * view.z + 40)}px`
    ta.style.height = `${b.h * view.z + 8}px`
    ta.style.font = `${it.size * view.z}px ${MONO}`
    ta.style.padding = it.type === 'code' ? `${(30) * view.z}px ${14 * view.z}px` : it.type === 'sticky' ? `${12 * view.z}px ${12 * view.z}px` : '0'
    ta.style.whiteSpace = it.type === 'sticky' ? 'pre-wrap' : 'pre'
  }
  editing = { it, ta }
  $('#stage').appendChild(ta)
  place()
  ta.focus()
  ta.select()
  ta.addEventListener('input', place)
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); ta.blur() }
    if (e.key === 'Tab' && it.type === 'code') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); place() }
    e.stopPropagation()
  })
  ta.addEventListener('blur', () => {
    const text = ta.value.replace(/\s+$/, '')
    ta.remove()
    editing = null
    const live = board.items.find(i => i.id === it.id)
    if (!live) return
    if (!text) board.items = board.items.filter(i => i.id !== it.id)
    else live.text = text
    drawBoard(); save()
  })
}

const svgEl = $('#board')
svgEl.addEventListener('pointerdown', e => {
  if (editing) return
  const [x, y] = toBoard(e)
  svgEl.setPointerCapture(e.pointerId)
  if (e.button === 1 || tool === 'hand' || spaceHeld) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
    svgEl.style.cursor = 'grabbing'
    return
  }
  const handle = e.target.closest('[data-handle]')?.dataset.handle
  if (tool === 'select' && handle && selection.size === 1) {
    const it = board.items.find(i => i.id === [...selection][0])
    snapshot()
    drag = { kind: 'resize', handle, it, start: JSON.parse(JSON.stringify(it)), box: boxOf(it), x, y }
    return
  }
  if (tool === 'select') {
    const id = itemAt(e)
    if (id) {
      if (e.shiftKey) selection.has(id) ? selection.delete(id) : selection.add(id)
      else if (!selection.has(id)) selection = new Set([id])
      snapshot()
      drag = { kind: 'move', x, y, starts: [...selection].map(sid => [sid, JSON.parse(JSON.stringify(board.items.find(i => i.id === sid)))]) }
    } else {
      if (!e.shiftKey) selection.clear()
      marquee = { x0: x, y0: y, x1: x, y1: y }
      drag = { kind: 'marquee' }
    }
    drawBoard()
    return
  }
  if (tool === 'eraser') {
    snapshot()
    drag = { kind: 'erase' }
    const id = itemAt(e)
    if (id) { board.items = board.items.filter(i => i.id !== id); drawBoard() }
    return
  }
  snapshot()
  const base = { id: uid(), color, width: stroke }
  if (tool === 'pen') {
    const it = { ...base, type: 'pen', points: [[x, y]] }
    board.items.push(it); drag = { kind: 'draw', it }
  } else if (tool === 'rect' || tool === 'ellipse') {
    const it = { ...base, type: tool, x, y, w: 0, h: 0, fill: e.altKey }
    board.items.push(it); drag = { kind: 'shape', it, x, y }
  } else if (tool === 'arrow' || tool === 'line') {
    const it = { ...base, type: tool, x1: x, y1: y, x2: x, y2: y }
    board.items.push(it); drag = { kind: 'segment', it }
  } else if (tool === 'text' || tool === 'code' || tool === 'sticky') {
    const it = tool === 'text' ? { ...base, type: 'text', x, y: y - 10, text: '', size: 18 }
      : tool === 'code' ? { ...base, type: 'code', x, y, text: '', size: 13, lang: 'code' }
      : { ...base, type: 'sticky', x, y, w: 220, text: '', size: 14, color: color === 'ink' ? 'accent' : color }
    board.items.push(it)
    selection = new Set([it.id])
    tool = 'select'; renderTools()
    // The editor opens on release: focusing it during the press loses focus
    // again to the board when the press ends.
    drag = { kind: 'place', it }
  }
  drawBoard()
})

svgEl.addEventListener('pointermove', e => {
  if (!drag) return
  const [x, y] = toBoard(e)
  if (drag.kind === 'pan') { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; applyView(); return }
  if (drag.kind === 'draw') {
    const last = drag.it.points[drag.it.points.length - 1]
    if (Math.hypot(x - last[0], y - last[1]) > 1.5 / view.z) drag.it.points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10])
  } else if (drag.kind === 'shape') {
    let w = x - drag.x; let h = y - drag.y
    if (e.shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s }
    drag.it.w = w; drag.it.h = h
  } else if (drag.kind === 'segment') {
    let x2 = x; let y2 = y
    if (e.shiftKey) { const a = Math.round(Math.atan2(y - drag.it.y1, x - drag.it.x1) / (Math.PI / 4)) * (Math.PI / 4); const d = Math.hypot(x - drag.it.x1, y - drag.it.y1); x2 = drag.it.x1 + Math.cos(a) * d; y2 = drag.it.y1 + Math.sin(a) * d }
    drag.it.x2 = x2; drag.it.y2 = y2
  } else if (drag.kind === 'move') {
    const dx = x - drag.x; const dy = y - drag.y
    for (const [id, s] of drag.starts) {
      const it = board.items.find(i => i.id === id)
      if (!it) continue
      if (it.type === 'pen') it.points = s.points.map(p => [p[0] + dx, p[1] + dy])
      else if (it.type === 'arrow' || it.type === 'line') Object.assign(it, { x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy })
      else Object.assign(it, { x: s.x + dx, y: s.y + dy })
    }
  } else if (drag.kind === 'resize') {
    const { it, start, box, handle } = drag
    if (handle === 'p1') Object.assign(it, { x1: x, y1: y })
    else if (handle === 'p2') Object.assign(it, { x2: x, y2: y })
    else {
      const left = handle.includes('w') ? Math.min(x, box.x + box.w - 8) : box.x
      const right = handle.includes('e') ? Math.max(x, box.x + 8) : box.x + box.w
      const top = handle.includes('n') ? Math.min(y, box.y + box.h - 8) : box.y
      const bottom = handle.includes('s') ? Math.max(y, box.y + 8) : box.y + box.h
      const sx = (right - left) / box.w; const sy = (bottom - top) / box.h
      if (it.type === 'pen') it.points = start.points.map(p => [left + (p[0] - box.x) * sx, top + (p[1] - box.y) * sy])
      else if (it.type === 'rect' || it.type === 'ellipse') Object.assign(it, { x: left, y: top, w: right - left, h: bottom - top })
      else if (it.type === 'sticky') Object.assign(it, { x: left, y: top, w: Math.max(100, right - left) })
      else Object.assign(it, { x: left, y: top, size: Math.max(8, Math.round(start.size * sy * 10) / 10) })
    }
  } else if (drag.kind === 'marquee') {
    marquee.x1 = x; marquee.y1 = y
    const mx = Math.min(marquee.x0, x); const my = Math.min(marquee.y0, y); const mw = Math.abs(x - marquee.x0); const mh = Math.abs(y - marquee.y0)
    selection = new Set(board.items.filter(it => { const b = boxOf(it); return b.x >= mx && b.y >= my && b.x + b.w <= mx + mw && b.y + b.h <= my + mh }).map(i => i.id))
  } else if (drag.kind === 'erase') {
    const id = itemAt(e)
    if (id) board.items = board.items.filter(i => i.id !== id)
  }
  drawBoard()
})

const endDrag = () => {
  if (!drag) return
  const d = drag
  drag = null
  marquee = null
  renderTools()
  if (d.kind === 'pan') return
  if (d.kind === 'place') { drawBoard(); return startEdit(d.it) }
  if (d.kind === 'shape' && Math.abs(d.it.w) < 4 && Math.abs(d.it.h) < 4) board.items = board.items.filter(i => i !== d.it)
  if (d.kind === 'segment' && Math.hypot(d.it.x2 - d.it.x1, d.it.y2 - d.it.y1) < 4) board.items = board.items.filter(i => i !== d.it)
  if (d.kind === 'shape') { const b = boxOf(d.it); Object.assign(d.it, b) }
  if (d.kind === 'marquee' || (d.kind === 'move' && history.length && history[history.length - 1] === JSON.stringify(board.items))) history.pop()
  drawBoard()
  if (d.kind !== 'marquee') save()
}
svgEl.addEventListener('pointerup', endDrag)
svgEl.addEventListener('pointercancel', endDrag)
svgEl.addEventListener('dblclick', e => {
  const id = itemAt(e)
  const it = board.items.find(i => i.id === id)
  if (it && (it.type === 'text' || it.type === 'code' || it.type === 'sticky')) { snapshot(); setTimeout(() => startEdit(it), 0) }
  else if (!it && tool === 'select') {
    const [x, y] = toBoard(e)
    snapshot()
    const t = { id: uid(), type: 'text', x, y: y - 10, text: '', size: 18, color }
    board.items.push(t); drawBoard(); setTimeout(() => startEdit(t), 0)
  }
})
svgEl.addEventListener('wheel', e => {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    const r = svgEl.getBoundingClientRect(); const px = e.clientX - r.left; const py = e.clientY - r.top
    const z = Math.min(4, Math.max(0.2, view.z * Math.exp(-e.deltaY * 0.01)))
    view.x = px - (px - view.x) * (z / view.z); view.y = py - (py - view.y) * (z / view.z); view.z = z
  } else { view.x -= e.deltaX; view.y -= e.deltaY }
  drawBoard()
}, { passive: false })

const contentBox = () => {
  const boxes = board.items.map(boxOf)
  if (board.underlay) {
    const svg = $('#underlayLayer svg')
    if (svg) boxes.push({ x: 0, y: 0, w: Number(svg.getAttribute('width')) || 800, h: Number(svg.getAttribute('height')) || 500 })
  }
  if (!boxes.length) return { x: 0, y: 0, w: 800, h: 500 }
  const x = Math.min(...boxes.map(b => b.x)); const y = Math.min(...boxes.map(b => b.y))
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y }
}
const fit = () => {
  const b = contentBox(); const r = svgEl.getBoundingClientRect()
  view.z = Math.min(2, Math.max(0.2, Math.min((r.width - 120) / b.w, (r.height - 80) / b.h)))
  view.x = (r.width - b.w * view.z) / 2 - b.x * view.z; view.y = (r.height - b.h * view.z) / 2 - b.y * view.z
  drawBoard()
}
const zoomBy = f => { const r = svgEl.getBoundingClientRect(); const cx = r.width / 2; const cy = r.height / 2; const z = Math.min(4, Math.max(0.2, view.z * f)); view.x = cx - (cx - view.x) * (z / view.z); view.y = cy - (cy - view.y) * (z / view.z); view.z = z; drawBoard() }

// The board as a PNG: its own drawing at 2x, on paper, around its content.
const boardPng = async () => {
  const b = contentBox(); const pad = 40
  const w = b.w + pad * 2; const h = b.h + pad * 2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad} ${w} ${h}" width="${w * 2}" height="${h * 2}"><rect x="${b.x - pad}" y="${b.y - pad}" width="${w}" height="${h}" fill="${cssVar('paper')}"/><g data-theme="${shownMode()}">${board.underlay ? underlaySvg : ''}</g>${board.items.map(itemSvg).join('')}</svg>`
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.min(8000, w * 2); canvas.height = Math.min(8000, h * 2)
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

// What the picture cannot say exactly: every text, sticky and code block, in
// reading order, plus what arrows connect and what is circled.
const describeBoard = () => {
  const items = [...board.items]
  const named = []
  for (const it of items.filter(i => i.type === 'text' || i.type === 'sticky' || i.type === 'code')) named.push({ name: it.type === 'code' ? 'the code block' : `"${it.text.split('\n')[0].slice(0, 40)}"`, box: boxOf(it) })
  if (board.underlay) document.querySelectorAll('#underlayLayer g[data-id]').forEach(g => {
    const bb = g.getBBox(); const node = data?.meta?.nodes?.find(n => n.id === g.dataset.id)
    named.push({ name: `the ${node?.label ?? g.dataset.id} component`, box: { x: bb.x, y: bb.y, w: bb.width, h: bb.height } })
  })
  const nearest = (x, y) => {
    let best = null; let dist = Infinity
    for (const n of named) {
      const dx = Math.max(n.box.x - x, 0, x - (n.box.x + n.box.w)); const dy = Math.max(n.box.y - y, 0, y - (n.box.y + n.box.h))
      const d = Math.hypot(dx, dy)
      if (d < dist) { dist = d; best = n }
    }
    return dist < 60 ? best : null
  }
  const lines = []
  const reading = items.filter(i => ['text', 'sticky', 'code'].includes(i.type)).sort((a, b) => boxOf(a).y - boxOf(b).y || boxOf(a).x - boxOf(b).x)
  for (const it of reading) {
    if (it.type === 'code') lines.push(`Code block${it.lang && it.lang !== 'code' ? ` (${it.lang})` : ''}:`, '```', it.text, '```')
    else lines.push(`${it.type === 'sticky' ? 'Sticky note' : 'Text'}: ${it.text}`)
  }
  const links = []
  for (const it of items.filter(i => i.type === 'arrow')) {
    const from = nearest(it.x1, it.y1); const to = nearest(it.x2, it.y2)
    if (from || to) links.push(`- Arrow from ${from?.name ?? 'an empty spot'} to ${to?.name ?? 'an empty spot'}`)
  }
  for (const it of items.filter(i => i.type === 'ellipse' || i.type === 'rect')) {
    const b = boxOf(it)
    const inside = named.filter(n => n.box.x >= b.x - 10 && n.box.y >= b.y - 10 && n.box.x + n.box.w <= b.x + b.w + 10 && n.box.y + n.box.h <= b.y + b.h + 10)
    if (inside.length) links.push(`- ${it.type === 'ellipse' ? 'Circled' : 'Boxed'}: ${inside.map(n => n.name).join(', ')}`)
  }
  const counts = {}
  for (const it of items) counts[it.type] = (counts[it.type] ?? 0) + 1
  const shapes = Object.entries(counts).map(([k, n]) => `${n} ${k === 'pen' ? 'freehand stroke' : k}${n > 1 ? 's' : ''}`).join(', ')
  return [
    ...lines,
    ...(links.length ? ['', 'Connections:', ...links] : []),
    '',
    `On the board: ${shapes || 'nothing yet'}${board.underlay ? ', drawn over the architecture diagram' : ''}.`,
  ].join('\n')
}

$('#boardTitle').addEventListener('change', () => { board.title = $('#boardTitle').value.trim() || 'Untitled board'; save() })
$('#boardList').addEventListener('change', e => loadBoard(e.target.value))
$('#boardNew').addEventListener('click', newBoard)
$('#underlay').addEventListener('change', async e => { board.underlay = e.target.checked; if (board.underlay) await loadUnderlay(); drawBoard(); save() })
$('#zoomIn').addEventListener('click', () => zoomBy(1.2))
$('#zoomOut').addEventListener('click', () => zoomBy(1 / 1.2))
$('#zoomFit').addEventListener('click', fit)
$('#boardPng').addEventListener('click', async () => {
  const a = document.createElement('a'); a.href = await boardPng(); a.download = `${board.title.replace(/[^\w-]+/g, '-')}.png`; a.click()
})
$('#boardSend').addEventListener('click', async () => {
  if (!board.items.length) return toast('The board is empty')
  $('#sendPreview').src = await boardPng()
  const open = (data.sessions ?? []).filter(s => isOpenSession(s) && s.id !== data.self)
  $('#sendTarget').innerHTML = [
    `<option value="${esc(data.self ?? '')}">This session${data.self ? ` · ${esc(sessionName(data.self))}` : ''}</option>`,
    ...open.map(s => `<option value="${esc(s.id)}">${esc(sessionName(s.id))}</option>`),
  ].join('')
  $('#sendTarget').style.display = open.length ? '' : 'none'
  $('#sendModal').classList.add('on')
  $('#sendNote').focus()
})
const sendBoard = async () => {
  const png = $('#sendPreview').src
  const note = $('#sendNote').value.trim()
  $('#sendModal').classList.remove('on')
  const target = $('#sendTarget').value || data.self
  const res = await api('/api/board/send', { id: board.id, title: board.title, png, md: describeBoard(), note, target })
  $('#sendNote').value = ''
  const where = target && target !== data.self ? sessionName(target) : 'this session'
  toast(res.ok ? `Sent to ${where}: Claude reads it as soon as it is free` : 'Could not send')
}
$('#sendGo').addEventListener('click', sendBoard)
$('#sendCancel').addEventListener('click', () => $('#sendModal').classList.remove('on'))
$('#sendNote').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendBoard(); if (e.key === 'Escape') $('#sendModal').classList.remove('on'); e.stopPropagation() })

// Clicks on the board's tools, colors and strokes (main.js routes them here).
const boardClick = t => {
  if (t.closest('[data-tool]')) { tool = t.closest('[data-tool]').dataset.tool; if (tool !== 'select') selection.clear(); renderTools(); drawBoard() }
  if (t.closest('[data-color]')) {
    color = t.closest('[data-color]').dataset.color
    if (selection.size) { snapshot(); for (const id of selection) { const it = board.items.find(i => i.id === id); if (it) it.color = color } drawBoard(); save() }
    renderTools()
  }
  if (t.closest('[data-stroke]')) {
    stroke = Number(t.closest('[data-stroke]').dataset.stroke)
    if (selection.size) { snapshot(); for (const id of selection) { const it = board.items.find(i => i.id === id); if (it && 'width' in it) it.width = stroke } drawBoard(); save() }
    renderTools()
  }
}

// The board's keys while it is open (main.js routes them here).
const boardKeys = (e, k, mod) => {
  if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo() }
  if (mod && k === 'y') { e.preventDefault(); return redo() }
  if (mod && k === 'a') { e.preventDefault(); selection = new Set(board.items.map(i => i.id)); return drawBoard() }
  if (mod && k === 'd' && selection.size) {
    e.preventDefault(); snapshot()
    const copies = [...selection].map(id => { const c = JSON.parse(JSON.stringify(board.items.find(i => i.id === id))); c.id = uid(); if (c.points) c.points = c.points.map(p => [p[0] + 20, p[1] + 20]); else if ('x1' in c) Object.assign(c, { x1: c.x1 + 20, y1: c.y1 + 20, x2: c.x2 + 20, y2: c.y2 + 20 }); else Object.assign(c, { x: c.x + 20, y: c.y + 20 }); return c })
    board.items.push(...copies); selection = new Set(copies.map(c => c.id)); drawBoard(); return save()
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) { snapshot(); board.items = board.items.filter(i => !selection.has(i.id)); selection.clear(); drawBoard(); return save() }
  if (e.key === 'Escape') { selection.clear(); tool = 'select'; renderTools(); return drawBoard() }
  if (e.key === 'Enter' && selection.size === 1) { const it = board.items.find(i => i.id === [...selection][0]); if (it && ['text', 'code', 'sticky'].includes(it.type)) { e.preventDefault(); snapshot(); return startEdit(it) } }
  if (!mod && k === 'f') return fit()
  if (!mod && k === '0') { view.z = 1; return drawBoard() }
  if (!mod && KEY_TOOL[k]) { tool = KEY_TOOL[k]; if (tool !== 'select') selection.clear(); renderTools(); return drawBoard() }
}

// Hold space to pan.
document.addEventListener('keydown', e => { if (e.key === ' ' && tab === 'board' && !isTyping(e)) { spaceHeld = true; svgEl.style.cursor = 'grab'; e.preventDefault() } })
document.addEventListener('keyup', e => { if (e.key === ' ') { spaceHeld = false; renderTools() } })
