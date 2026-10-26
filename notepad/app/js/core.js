// Shared by every tab: the server's address, text formatting, panes, sessions,
// light and dark, and the notepad's own dialogs. Loaded first; the other files
// are plain scripts too, so they all share one set of names.

const token = new URLSearchParams(location.search).get('t')
// The session this page is for (each session's Open notepad adds it).
const forSession = new URLSearchParams(location.search).get('s') ?? ''
const $ = s => document.querySelector(s)
const api = (p, body) =>
  fetch(`${p}${p.includes('?') ? '&' : '?'}t=${token}${forSession ? `&s=${encodeURIComponent(forSession)}` : ''}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-notepad-token': token }, body: JSON.stringify(body) } : {})
    .then(r => r.json())
    .then(j => { if (j?.cursorPrompt) toCursor(j.cursorPrompt); return j })
// In Cursor, a request for the agent comes back as a prompt: it opens in
// Cursor's chat through a prompt link (press Enter there to run it), and is
// copied too; one too long for a link (8,000 characters) is only copied.
// Cursor's link reader drops text after an "&", so none goes in.
const toCursor = async prompt => {
  try { await navigator.clipboard.writeText(prompt) } catch {}
  const link = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt.replace(/&/g, 'and'))}`
  const fits = link.length <= 8000
  if (fits) location.href = link
  // After the caller's own toast, so this one is what shows.
  setTimeout(() => toast(fits ? 'Opened in Cursor: press Enter in its chat to run it (also copied)' : 'Copied the request: paste it into Cursor’s chat and press Enter'), 80)
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const inline = s => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  .replace(/(^|[\s(])_([^_]+)_(?=[\s).,:;!?]|$)/g, '$1<em>$2</em>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
// A note's first line, for the side panel.
const firstLine = text => inline(String(text ?? '').split('\n').find(l => l.trim())?.replace(/^\s*[-*] /, '') ?? '')
// What you write in a note: inline formatting, line breaks and "- " lists.
const rich = text => {
  const out = []
  let list = false
  for (const line of String(text ?? '').split('\n')) {
    const item = /^\s*[-*] (.*)$/.exec(line)
    if (item) { if (!list) { out.push('<ul>'); list = true } out.push(`<li>${inline(item[1])}</li>`); continue }
    if (list) { out.push('</ul>'); list = false }
    out.push(line.trim() ? `<div>${inline(line)}</div>` : '<div class="gap"></div>')
  }
  if (list) out.push('</ul>')
  return out.join('')
}
const md = text => {
  const out = []
  let list = false
  for (const line of String(text).split('\n')) {
    const item = /^- (.*)$/.exec(line)
    if (item) { if (!list) { out.push('<ul>'); list = true } out.push(`<li>${inline(item[1])}</li>`); continue }
    if (list) { out.push('</ul>'); list = false }
    const h = /^(#{1,3}) (.*)$/.exec(line)
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push('</ul>')
  return out.join('')
}
const time = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const toast = text => { const t = $('#toast'); t.textContent = text; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 1800) }
const isTyping = e => !!e.target.closest('input, textarea, select, [contenteditable]')

// Pane sizes and which panes are hidden, kept in this browser.
const PANES = {
  nav: { min: 160, max: 440, def: 240, grows: 1 },
  rail: { min: 220, max: 560, def: 300, grows: -1 },
  drawer: { min: 320, max: 900, def: 460, grows: -1 },
}
const layout = (() => { try { return JSON.parse(localStorage.getItem('arch-live-layout') || '{}') } catch { return {} } })()
const saveLayout = () => { try { localStorage.setItem('arch-live-layout', JSON.stringify(layout)) } catch {} }
const applyLayout = () => {
  for (const [pane, p] of Object.entries(PANES)) document.documentElement.style.setProperty(`--${pane}-w`, `${layout[pane] ?? p.def}px`)
  $('#app').classList.toggle('navless', !!layout.navHidden)
  document.body.classList.toggle('railless', !!layout.railHidden)
  const nav = document.querySelector('.gutter[data-pane="nav"]')
  const rail = document.querySelector('.gutter[data-pane="rail"]')
  nav.classList.toggle('closed', !!layout.navHidden)
  rail.classList.toggle('closed', !!layout.railHidden)
  nav.querySelector('button').textContent = layout.navHidden ? '›' : '‹'
  nav.querySelector('button').title = layout.navHidden ? 'Show days (\\)' : 'Hide days (\\)'
  $('#navToggle').title = layout.navHidden ? 'Show the sidebar (\\)' : 'Hide the sidebar (\\)'
  rail.querySelector('button').textContent = layout.railHidden ? '‹' : '›'
  rail.querySelector('button').title = layout.railHidden ? 'Show this panel' : 'Hide this panel'
}
const togglePane = pane => {
  if (pane === 'drawer') return closeDrawer()
  layout[`${pane}Hidden`] = !layout[`${pane}Hidden`]
  applyLayout(); saveLayout()
}
// Dragging a divider: narrower than its minimum hides the pane, dragging a
// hidden one back out shows it again.
document.querySelectorAll('.gutter').forEach(g => {
  g.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return
    const pane = g.dataset.pane
    const p = PANES[pane]
    const hiddenKey = `${pane}Hidden`
    const startX = e.clientX
    const startW = layout[hiddenKey] ? 0 : (layout[pane] ?? p.def)
    g.setPointerCapture(e.pointerId)
    g.classList.add('dragging'); document.body.classList.add('dragging-pane')
    const move = ev => {
      const w = startW + (ev.clientX - startX) * p.grows
      const isHiding = pane !== 'drawer' && w < p.min - 60
      if (pane !== 'drawer') layout[hiddenKey] = isHiding
      // Hidden by the drag, it keeps the width it had, to come back at.
      if (isHiding) { if (startW) layout[pane] = startW }
      else layout[pane] = Math.round(Math.min(p.max, Math.max(p.min, w)))
      applyLayout()
    }
    const up = () => {
      g.classList.remove('dragging'); document.body.classList.remove('dragging-pane')
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up)
      saveLayout()
    }
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up)
  })
  g.addEventListener('dblclick', e => {
    if (e.target.closest('button')) return
    delete layout[g.dataset.pane]
    applyLayout(); saveLayout()
  })
})
document.addEventListener('click', e => { const b = e.target.closest('[data-collapse]'); if (b) togglePane(b.dataset.collapse) })
applyLayout()

let data = null
let date = null
let tab = 'journal'
let type = 'note'
let viewSession = null // a session id to show its history, or null for the day

// Sessions: one file each, named after their first request until renamed.
const sessionById = id => (data?.sessions ?? []).find(s => s.id === id)
const sessionName = id => (id ? (sessionById(id)?.name ?? 'Unnamed session') : 'Earlier work')
const isOpenSession = s => s && !s.endedAt
// The sessions the sidebar lists, newest first: any with entries, any open
// now, and this one. The standup picker offers the same list.
const sidebarSessions = () => {
  const counts = data?.sessionCounts ?? {}
  return (data?.sessions ?? []).filter(s => counts[s.id] || isOpenSession(s) || s.id === data.self).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
}

// Light or dark: the viewer's choice (Auto, Light, Dark, kept in this browser),
// else the theme's own mode, else the system setting. data-theme on <html>
// also drives the diagram SVG, which reads it.
const MODES = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }
let viewMode = (() => { try { return localStorage.getItem('arch-live-mode') || 'auto' } catch { return 'auto' } })()
let savedTheme = null
const systemDark = matchMedia('(prefers-color-scheme: dark)')
const shownMode = () => document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light')

const applyTheme = theme => {
  if (theme) savedTheme = theme
  const t = savedTheme
  const forced = viewMode !== 'auto' ? viewMode : t && t.mode !== 'auto' ? t.mode : null
  if (forced) document.documentElement.dataset.theme = forced
  else delete document.documentElement.dataset.theme
  $('#mode').textContent = MODES[viewMode] ?? MODES.auto
  if (!t) return
  const vars = p => Object.entries(p).map(([k, v]) => `--${k}:${v}`).join(';')
  const font = t.fonts?.sans ? `--font:${t.fonts.sans};` : ''
  $('#theme').textContent = `:root{${vars(t.light)};${font}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${vars(t.dark)}}}` +
    `:root[data-theme="dark"]{${vars(t.dark)}}`
}

// The board draws with resolved colors, so it redraws when the mode changes.
const modeChanged = () => { if (tab === 'board') { renderTools(); drawBoard() } }
$('#mode').addEventListener('click', () => {
  viewMode = { auto: 'light', light: 'dark', dark: 'auto' }[viewMode] ?? 'auto'
  try { localStorage.setItem('arch-live-mode', viewMode) } catch {}
  applyTheme()
  modeChanged()
})
systemDark.addEventListener('change', () => { if (!document.documentElement.dataset.theme) modeChanged() })
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()

const label = id => (id && data?.labels?.[id]) || id || ''
const ICON = { note: '✎', todo: '☐', blocker: '⛔', decision: '◆', mark: '◯' }

/* ---------- The notepad's own dialogs ---------- */

// In place of the browser's prompt and confirm: same keys (Enter or ⌘↵ to
// accept, Esc to cancel), styled like the rest of the notepad.
let askDone = null
const closeAsk = value => {
  $('#askModal').classList.remove('on')
  const done = askDone
  askDone = null
  done?.(value)
}
const askDialog = ({ title, body = '', value = '', placeholder = '', ok = 'OK', isMultiline = false, isConfirm = false, isDanger = false }) =>
  new Promise(resolve => {
    if (askDone) closeAsk(null)
    askDone = resolve
    $('#askTitle').textContent = title
    $('#askBody').textContent = body
    $('#askBody').hidden = !body
    const input = $('#askInput'); const area = $('#askArea')
    input.hidden = isConfirm || isMultiline
    area.hidden = isConfirm || !isMultiline
    const field = isMultiline ? area : input
    field.value = value
    field.placeholder = placeholder
    $('#askOk').textContent = ok
    $('#askOk').classList.toggle('danger', isDanger)
    $('#askKeys').textContent = isConfirm ? '↵ ok · Esc cancel' : isMultiline ? '⌘↵ save · Esc cancel' : '↵ save · Esc cancel'
    $('#askModal').classList.add('on')
    setTimeout(() => (isConfirm ? $('#askOk') : field).focus(), 0)
    if (!isConfirm) field.select()
  })
const askText = opts => askDialog(opts)
const askConfirm = opts => askDialog({ ...opts, isConfirm: true }).then(v => v === true)
$('#askOk').addEventListener('click', () => closeAsk($('#askInput').hidden && $('#askArea').hidden ? true : (!$('#askArea').hidden ? $('#askArea').value : $('#askInput').value)))
$('#askCancel').addEventListener('click', () => closeAsk(null))
$('#askModal').addEventListener('click', e => { if (e.target === $('#askModal')) closeAsk(null) })
$('#askModal').addEventListener('keydown', e => {
  e.stopPropagation()
  if (e.key === 'Escape') { e.preventDefault(); closeAsk(null) }
  const isArea = e.target === $('#askArea')
  if (e.key === 'Enter' && (!isArea || e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#askOk').click() }
})
