/* ---------- Timeline ---------- */

// How the map changed, step by step (from /api/timeline, built from the
// journal's daily snapshots): a list on the left, newest first, and the
// chosen step on the right: the map after it, with what it added in the
// accent, what it removed dashed, and the turns that did it.
let tlSteps = []
let tlKey = null
const tlStepKey = s => `${s.date}:${s.kind}`
const tlDay = date => new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const tlTitle = s => `${tlDay(s.date)}${s.kind === 'between' ? ' · outside a session' : ''}`
const tlCounts = s => {
  const links = s.linked.length + s.unlinked.length
  return [
    s.added.length ? `${s.added.length} added` : '',
    s.removed.length ? `${s.removed.length} removed` : '',
    s.renamed.length ? `${s.renamed.length} renamed` : '',
    links ? `${links} connection${links === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ') || 'no change to the map itself'
}

// The step's map: the components after it plus the ones it removed, in
// columns by kind (as the Diagram tab's tiers), lines between their sides.
const TL = { W: 168, H: 40, GX: 64, GY: 14, TOP: 34, LEFT: 12 }
const tlMap = s => {
  const removedIds = new Set(s.removed.map(n => n.id))
  const addedIds = new Set(s.added.map(n => n.id))
  const renamed = new Map(s.renamed.map(r => [r.id, r]))
  const nodes = [...s.after.nodes, ...s.removed]
  const tiers = [...new Set(nodes.map(n => TIER[n.kind] ?? 2))].sort((a, b) => a - b)
  const at = {}
  const columns = tiers.map(t => nodes.filter(n => (TIER[n.kind] ?? 2) === t))
  columns.forEach((col, i) => col.forEach((n, j) => { at[n.id] = { x: TL.LEFT + i * (TL.W + TL.GX), y: TL.TOP + j * (TL.H + TL.GY) } }))
  const width = TL.LEFT * 2 + tiers.length * TL.W + (tiers.length - 1) * TL.GX
  const height = TL.TOP + Math.max(...columns.map(c => c.length)) * (TL.H + TL.GY) + 4
  const key = l => `${l.from}>${l.to}`
  const linked = new Set(s.linked.map(key))
  const lines = [...s.after.edges.map(l => ({ ...l, state: linked.has(key(l)) ? 'new' : '' })), ...s.unlinked.map(l => ({ ...l, state: 'gone' }))]
  const out = [`<defs>${['muted', 'accent', 'soft'].map(c => `<marker id="tl-${c}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" style="fill:var(--${c})"/></marker>`).join('')}</defs>`]
  tiers.forEach((t, i) => out.push(`<text class="tl-tier" x="${TL.LEFT + i * (TL.W + TL.GX)}" y="${TL.TOP - 14}">${TIER_LABEL[t] ?? ''}</text>`))
  for (const l of lines) {
    const a = at[l.from]; const b = at[l.to]
    if (!a || !b) continue
    const isRight = b.x > a.x
    const x1 = a.x === b.x ? a.x + TL.W / 2 : isRight ? a.x + TL.W : a.x
    const x2 = a.x === b.x ? b.x + TL.W / 2 : isRight ? b.x : b.x + TL.W
    const y1 = a.x === b.x ? (b.y > a.y ? a.y + TL.H : a.y) : a.y + TL.H / 2
    const y2 = a.x === b.x ? (b.y > a.y ? b.y : b.y + TL.H) : b.y + TL.H / 2
    const d = a.x === b.x
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`
    const color = l.state === 'new' ? 'accent' : l.state === 'gone' ? 'soft' : 'muted'
    out.push(`<path d="${d}" class="tl-edge ${l.state}" marker-end="url(#tl-${color})"><title>${esc(`${label(l.from) || l.from} → ${label(l.to) || l.to}${l.label ? ` · ${l.label}` : ''}`)}</title></path>`)
  }
  for (const n of nodes) {
    const p = at[n.id]
    const state = removedIds.has(n.id) ? 'gone' : addedIds.has(n.id) ? 'new' : renamed.has(n.id) ? 'renamed' : ''
    const tag = { new: 'NEW', gone: 'REMOVED', renamed: 'RENAMED' }[state] ?? ''
    const tip = renamed.has(n.id) ? `${renamed.get(n.id).from} → ${n.label}` : `${n.label} · ${n.kind}`
    out.push(`<g class="tl-node ${state}"><title>${esc(tip)}</title><rect x="${p.x}" y="${p.y}" width="${TL.W}" height="${TL.H}" rx="6"/><text class="tl-label" x="${p.x + 10}" y="${p.y + 17}">${esc(cutText(n.label, 22))}</text><text class="tl-kind" x="${p.x + 10}" y="${p.y + 31}">${esc(n.kind)}</text>${tag ? `<text class="tl-tag" x="${p.x + TL.W - 8}" y="${p.y + 13}" text-anchor="end">${tag}</text>` : ''}</g>`)
  }
  return `<svg class="tl-map" viewBox="0 0 ${width} ${height}" style="max-width:${width}px;min-width:${Math.round(width * 0.75)}px" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(`The map after ${tlTitle(s)}`)}">${out.join('')}</svg>`
}

const tlDetail = s => {
  const names = new Map([...s.after.nodes, ...s.removed].map(n => [n.id, n.label]))
  const name = id => names.get(id) ?? id
  const link = l => `${esc(name(l.from))} → ${esc(name(l.to))}${l.label ? ` <span class="hint">${esc(l.label)}</span>` : ''}`
  const row = (what, items) => (items.length ? `<div class="tl-row"><span class="tl-what">${what}</span><span>${items.join(', ')}</span></div>` : '')
  const turns = s.turns.map(t => {
    const did = [t.added.length ? `added ${t.added.join(', ')}` : '', t.removed.length ? `removed ${t.removed.join(', ')}` : ''].filter(Boolean).join('; ')
    return `<li><span class="hint">${esc(time(t.ts))}${t.session ? ` · ${esc(sessionName(t.session))}` : ''}</span> ${inline(t.request)} <span class="hint">· ${esc(did)}</span></li>`
  })
  return [
    `<div class="tl-head"><h2>${esc(tlTitle(s))}</h2><span class="hint">${esc(tlCounts(s))}</span><span class="spacer"></span>${s.kind === 'day' ? `<button class="btn" data-tl-journal="${esc(s.date)}">Open the day in the journal</button>` : ''}<button class="btn" data-tl-copy>Copy</button></div>`,
    s.kind === 'between' ? '<div class="hint tl-note">Changed outside any session since the day before: a pull, a merge or an edit by hand.</div>' : '',
    `<div class="tl-mapwrap">${tlMap(s)}</div>`,
    '<div class="tl-changes">',
    row('Added', s.added.map(n => `<b>${esc(n.label)}</b> <span class="hint">${esc(n.kind)}</span>`)),
    row('Removed', s.removed.map(n => `<del>${esc(n.label)}</del>`)),
    row('Renamed', s.renamed.map(r => `${esc(r.from)} → <b>${esc(r.to)}</b>`)),
    row('New connections', s.linked.map(link)),
    row('Connections gone', s.unlinked.map(link)),
    '</div>',
    turns.length ? `<h3 class="tl-sub">What did it</h3><ul class="tl-turns">${turns.join('')}</ul>` : '',
  ].join('')
}

// The step as Markdown, for Copy.
const tlMarkdown = s => {
  const names = new Map([...s.after.nodes, ...s.removed].map(n => [n.id, n.label]))
  const link = l => `${names.get(l.from) ?? l.from} → ${names.get(l.to) ?? l.to}`
  return [
    `**${tlTitle(s)}** · ${tlCounts(s)}`,
    s.added.length ? `- Added: ${s.added.map(n => `${n.label} (${n.kind})`).join(', ')}` : '',
    s.removed.length ? `- Removed: ${s.removed.map(n => n.label).join(', ')}` : '',
    s.renamed.length ? `- Renamed: ${s.renamed.map(r => `${r.from} → ${r.to}`).join(', ')}` : '',
    s.linked.length ? `- New connections: ${s.linked.map(link).join(', ')}` : '',
    s.unlinked.length ? `- Connections gone: ${s.unlinked.map(link).join(', ')}` : '',
    ...s.turns.map(t => `- ${time(t.ts)} ${t.request}`),
  ].filter(Boolean).join('\n')
}

const renderTimeline = async () => {
  tlSteps = (await api('/api/timeline')).steps ?? []
  if (!tlSteps.length) {
    $('#tlList').innerHTML = ''
    $('#tlDetail').innerHTML = '<div class="empty">No map changes recorded yet. Each day the map changes, the journal keeps how it stood, and its history shows here.</div>'
    return
  }
  const newest = [...tlSteps].reverse()
  const chosen = newest.find(s => tlStepKey(s) === tlKey) ?? newest[0]
  tlKey = tlStepKey(chosen)
  const rows = []
  let month = ''
  for (const s of newest) {
    const m = new Date(`${s.date}T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })
    if (m !== month) { month = m; rows.push(`<div class="hist-month">${esc(m)}</div>`) }
    rows.push(`<button class="tl-step${s.kind === 'between' ? ' between' : ''}" data-tl-step="${esc(tlStepKey(s))}" aria-current="${s === chosen}"><span class="when">${esc(tlTitle(s))}</span><span class="what">${esc(tlCounts(s))}</span></button>`)
  }
  $('#tlList').innerHTML = rows.join('')
  $('#tlDetail').innerHTML = tlDetail(chosen)
}

const timelineClick = async t => {
  const step = t.closest('[data-tl-step]')
  if (step) { tlKey = step.dataset.tlStep; return renderTimeline() }
  const day = t.closest('[data-tl-journal]')
  if (day) { date = day.dataset.tlJournal; await setTab('journal'); return load() }
  if (t.closest('[data-tl-copy]')) {
    const s = tlSteps.find(x => tlStepKey(x) === tlKey)
    if (s) { await navigator.clipboard.writeText(tlMarkdown(s)); toast('Step copied') }
  }
}

// ↑ and ↓ move through the steps.
const timelineKeys = e => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const newest = [...tlSteps].reverse()
  const i = newest.findIndex(s => tlStepKey(s) === tlKey) + (e.key === 'ArrowDown' ? 1 : -1)
  if (!newest[i]) return
  tlKey = tlStepKey(newest[i])
  e.preventDefault()
  renderTimeline().then(() => document.querySelector('.tl-step[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }))
}
