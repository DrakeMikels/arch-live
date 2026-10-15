/* ---------- Command palette ---------- */

// ⌘K (Ctrl+K) outside a text field: one box to jump anywhere — a tab, a component, a day, a past
// standup, a file — or to run an action. Type a few letters of what you want;
// ↑ ↓ to choose, ↵ to go, Esc to close.

let paletteItems = []
let paletteShown = []
let paletteAt = 0
let paletteFiles = null

const TAB_NAMES = { journal: 'Journal', diagram: 'Diagram', board: 'Board', standup: 'Standup', timeline: 'Timeline', insights: 'Insights' }

// Everything the palette offers, built when it opens.
const buildPalette = async () => {
  const items = []
  const add = (kind, text, run, hint = '') => items.push({ kind, text, hint, run })
  for (const [id, name] of Object.entries(TAB_NAMES)) add('Tab', name, () => setTab(id))
  add('Action', 'Add a note', async () => { await setTab('journal'); input.focus() })
  add('Action', 'Search every day', async () => { await setTab('journal'); $('#search').focus() })
  add('Action', 'Write the standup with Claude', async () => { await setTab('standup'); $('#writeStandup').click() })
  add('Action', 'Copy the standup for Slack', async () => { await setTab('standup'); $('#copyStandup').click() })
  add('Action', 'Re-map the project with Claude', async () => {
    const res = await api('/api/ask', { kind: 'map' })
    toast(res.ok ? 'Asked Claude to re-map the project' : 'Could not reach the session')
  })
  add('Action', 'New board', async () => { await setTab('board'); $('#boardNew').click() })
  add('Action', 'Fit the diagram', async () => { await setTab('diagram'); fitMap() })
  for (const [id, o] of Object.entries(OVERLAYS)) add('Overlay', `Diagram overlay: ${o.label}`, async () => { await setTab('diagram'); setOverlay(id) })
  add('Action', 'Switch light and dark', () => $('#mode').click())
  add('Action', 'Settings', () => $('#settingsBtn').click())
  add('Action', 'Help and shortcuts', () => openModal('#helpModal'))

  const graph = mapData ?? (await api('/api/graph').catch(() => null))
  for (const n of graph?.nodes ?? []) add('Component', n.label, () => showComponent(n.id), n.kind)
  for (const d of data?.dates ?? []) add('Day', d.label, async () => { date = d.date; viewSession = null; await setTab('journal'); load() }, d.count ? `${d.count} entries` : '')
  const past = await api('/api/standups').catch(() => null)
  for (const a of past?.standups ?? []) {
    add('Standup', `Standup · ${longDay(a.at)}`, async () => { await setTab('standup'); standupView = 'history'; await renderStandup(); showArchived(a.id) }, a.scope)
  }
  paletteFiles ??= (await api('/api/files').catch(() => null))?.files ?? []
  return items
}

// A fuzzy score: each word of the query, in any order, has every letter in
// order in the text; more for runs and word starts.
const fuzzy = (query, text) => {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length > 1) {
    const scores = words.map(w => fuzzyWord(w, text))
    return scores.some(x => x <= 0) ? 0 : scores.reduce((sum, x) => sum + x, 0)
  }
  return fuzzyWord(query, text)
}
const fuzzyWord = (query, text) => {
  const q = query.toLowerCase(); const t = text.toLowerCase()
  if (!q) return 1
  let score = 0; let at = -1; let run = 0
  for (const ch of q) {
    const i = t.indexOf(ch, at + 1)
    if (i < 0) return 0
    run = i === at + 1 ? run + 1 : 0
    score += 1 + run * 2 + (i === 0 || /[\s/._-]/.test(t[i - 1]) ? 3 : 0)
    at = i
  }
  return score - t.length * 0.01
}

const renderPalette = () => {
  const q = $('#paletteInput').value.trim()
  const scored = paletteItems.map(it => ({ it, s: fuzzy(q, it.text) })).filter(x => x.s > 0)
  // Files only when you type: there may be thousands.
  if (q.length >= 2) {
    for (const f of paletteFiles ?? []) {
      const s = fuzzy(q, f)
      if (s > 0) scored.push({ it: { kind: 'File', text: f, hint: 'open in editor', run: () => openFile(f, 1) }, s: s - 1 })
    }
  }
  paletteShown = scored.sort((a, b) => b.s - a.s).slice(0, 40).map(x => x.it)
  paletteAt = Math.min(paletteAt, Math.max(0, paletteShown.length - 1))
  $('#paletteList').innerHTML = paletteShown.length
    ? paletteShown.map((it, i) => `<div class="pitem${i === paletteAt ? ' on' : ''}" data-pi="${i}" role="option" aria-selected="${i === paletteAt}"><span class="pkind">${esc(it.kind)}</span><span class="ptext">${esc(it.text)}</span><span class="hint">${esc(it.hint)}</span></div>`).join('')
    : '<div class="hint pempty">Nothing matches.</div>'
  $('#paletteList').querySelector('.pitem.on')?.scrollIntoView({ block: 'nearest' })
}

const openPalette = async () => {
  $('#paletteModal').classList.add('on')
  $('#paletteInput').value = ''
  paletteAt = 0
  $('#paletteInput').focus()
  $('#paletteList').innerHTML = '<div class="hint pempty">Loading…</div>'
  paletteItems = await buildPalette()
  renderPalette()
}
const closePalette = () => $('#paletteModal').classList.remove('on')
const runPalette = async i => {
  const it = paletteShown[i]
  if (!it) return
  closePalette()
  await it.run()
}

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    // While writing a note, ⌘K is the link shortcut: leave it alone there.
    if (isTyping(e) && e.target !== $('#paletteInput')) return
    e.preventDefault(); e.stopPropagation()
    return $('#paletteModal').classList.contains('on') ? closePalette() : openPalette()
  }
}, true)
$('#paletteInput').addEventListener('input', () => { paletteAt = 0; renderPalette() })
$('#paletteModal').addEventListener('keydown', e => {
  e.stopPropagation()
  if (e.key === 'Escape') { e.preventDefault(); return closePalette() }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    paletteAt = (paletteAt + (e.key === 'ArrowDown' ? 1 : -1) + paletteShown.length) % Math.max(1, paletteShown.length)
    return renderPalette()
  }
  if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteAt) }
})
$('#paletteList').addEventListener('click', e => { const row = e.target.closest('[data-pi]'); if (row) runPalette(Number(row.dataset.pi)) })
$('#paletteList').addEventListener('pointermove', e => {
  const row = e.target.closest('[data-pi]')
  if (row && Number(row.dataset.pi) !== paletteAt) { paletteAt = Number(row.dataset.pi); renderPalette() }
})
$('#paletteModal').addEventListener('click', e => { if (e.target === $('#paletteModal')) closePalette() })
