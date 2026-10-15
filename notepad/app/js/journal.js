/* ---------- Journal ---------- */

// One journal entry, as a row.
const fromDay = date => new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const entryHtml = (e, showSession, dayDate) => {
  const sessionChip = showSession && e.session ? `<span class="chip session">${esc(sessionName(e.session))}</span>` : ''
  if (e.type === 'done') {
    const from = e.refDate && e.refDate !== dayDate ? ` <span class="why">· ${esc(e.refType ?? 'item')} from ${esc(fromDay(e.refDate))}</span>` : ''
    const verb = e.refType === 'mark' ? 'Cleared mark' : 'Done'
    return `<div class="entry note-row completed" data-entry="${esc(e.id)}"><time>${time(e.ts)}</time><div><span class="icon">✓</span><span class="text">${verb}: ${inline(e.refText ?? 'an item')}</span>${from}${sessionChip}<span class="badge">${esc(e.refType ?? 'done')}</span></div></div>`
  }
  if (e.type === 'commit') {
    // Opening the list loads each file's added and removed lines (commitToggle).
    const files = `<details data-commit="${esc(e.sha)}"><summary>${e.files.length} file${e.files.length > 1 ? 's' : ''}</summary><div class="commitfiles">${e.files.map(f => `<div><code class="link" data-open="${esc(f)}" title="Open in editor">${esc(f)}</code></div>`).join('')}</div></details>`
    return `<div class="entry commit-row" data-entry="${esc(e.id)}"><time>${time(e.ts)}</time><div><span class="icon">⎇</span><span class="text">Committed <code title="${esc(e.sha)}">${esc(e.sha.slice(0, 7))}</code> ${inline(e.subject)}</span>${files}</div></div>`
  }
  if (e.type === 'turn') {
    const chips = e.components.map(c => `<span class="chip link" data-comp="${esc(c)}" title="Show on the diagram">${esc(label(c))}</span>`).join('')
    // How its tests stood, and whether its files are committed yet.
    const tests = e.tests ? `<span class="badge ${e.tests.failed ? 'bad' : 'good'}" title="${esc(e.tests.command)}">${e.tests.failed ? `${e.tests.failed} failing · ` : ''}${e.tests.passed} passed</span>` : ''
    const ship = !e.files.length || !e.uncommitted ? ''
      : !e.uncommitted.length ? `<span class="badge good" title="${esc((e.shipped ?? []).map(c => `${c.sha.slice(0, 7)} ${c.subject}`).join('\n'))}">shipped ${esc((e.shipped ?? []).map(c => c.sha.slice(0, 7)).join(', '))}</span>`
      : `<span class="badge warn" title="${esc(e.uncommitted.join('\n'))}">${e.shipped?.length ? `${e.files.length - e.uncommitted.length} of ${e.files.length} committed` : 'not committed'}</span>`
    const files = e.files.length ? `<details><summary>${e.files.length} file${e.files.length > 1 ? 's' : ''}${e.commands ? ` · ${e.commands} command${e.commands > 1 ? 's' : ''}` : ''}</summary>${e.files.map(f => `<div>${f.created ? '+ ' : '~ '}<code class="link" data-open="${esc(f.path)}" title="Open in editor">${esc(f.path)}</code></div>`).join('')}</details>` : ''
    const arch = e.arch ? `<div class="hint">Map: ${e.arch.added.length ? `added ${esc(e.arch.added.join(', '))}` : ''}${e.arch.removed.length ? ` removed ${esc(e.arch.removed.join(', '))}` : ''}</div>` : ''
    return `<div class="entry" data-entry="${esc(e.id)}"><time>${time(e.ts)}</time><div><span class="what">${inline(e.request)}</span>${chips}${sessionChip}${tests}${ship}<ul>${e.summary.map(s => `<li>${inline(s)}</li>`).join('')}</ul>${arch}${files}</div></div>`
  }
  const checkable = e.type === 'todo' || e.type === 'blocker'
  const icon = checkable ? `<input type="checkbox" class="check" data-done="${e.id}" ${e.done ? 'checked' : ''} title="${e.done ? 'Reopen' : 'Mark done'}">` : `<span class="icon">${ICON[e.type] ?? '•'}</span>`
  const why = e.why ? ` <span class="why">— because ${inline(e.why)}</span>` : ''
  const alt = e.alternatives ? ` <span class="why">(considered: ${inline(e.alternatives)})</span>` : ''
  const chip = e.component ? `<span class="chip link" data-comp="${esc(e.component)}" title="Show on the diagram">${esc(label(e.component))}</span>` : ''
  const by = e.by === 'claude' ? '<span class="badge">Claude</span>' : ''
  const kind = e.type === 'note' ? '' : `<span class="badge">${e.type}</span>`
  const edited = e.editedAt ? `<span class="badge" title="Edited ${esc(new Date(e.editedAt).toLocaleString())}">edited</span>` : ''
  return `<div class="entry note-row ${e.done ? 'done' : ''}" data-entry="${esc(e.id)}"><time>${time(e.ts)}</time><div class="note-body">${icon}<div class="note-main"><div class="text rich" title="Double-click to edit">${rich(e.text)}</div>${why}${alt}${chip}${sessionChip}${kind}${by}${edited}</div><button class="edit-btn" data-edit="${esc(e.id)}" title="Edit">✎</button></div></div>`
}
const countLine = entries => {
  const turns = entries.filter(e => e.type === 'turn').length
  const done = entries.filter(e => e.type === 'done').length
  const commits = entries.filter(e => e.type === 'commit').length
  const notes = entries.length - turns - done - commits
  return entries.length ? [`${turns} turn${turns === 1 ? '' : 's'}`, `${notes} note${notes === 1 ? '' : 's'}`, done ? `${done} done` : '', commits ? `${commits} commit${commits === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') : ''
}

// The sidebar, like the Claude app's: this project's sessions by title, newest
// first under Today / Yesterday / This week / Older, then the days.
const renderNav = () => {
  const now = new Date()
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const DAY = 864e5
  const group = ts => (ts >= t0 ? 'Today' : ts >= t0 - DAY ? 'Yesterday' : ts >= t0 - 6 * DAY ? 'This week' : 'Older')
  const when = ts => (ts >= t0 ? time(ts) : ts >= t0 - 6 * DAY ? new Date(ts).toLocaleDateString([], { weekday: 'short' }) : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }))
  const counts = data.sessionCounts ?? {}
  const list = sidebarSessions()
  const rows = []
  let heading = ''
  for (const s of list) {
    const g = group(s.lastAt ?? 0)
    if (g !== heading) { heading = g; rows.push(`<div class="group">${g}</div>`) }
    const dot = isOpenSession(s) ? '<span class="live-dot" title="Open now"></span>' : '<span class="ended-dot" title="Closed"></span>'
    const elsewhere = s.folder && s.folder !== data.project ? `Runs in ${s.folder.split('/').pop()} · ` : ''
    const meta = [s.id === data.self ? 'this session' : '', when(s.lastAt ?? 0), elsewhere ? `in ${s.folder.split('/').pop()}` : ''].filter(Boolean).join(' · ')
    rows.push(`<button class="session-row" data-session="${esc(s.id)}" aria-current="${viewSession === s.id}" title="${esc(`${sessionName(s.id)}\n${elsewhere}${counts[s.id] ?? 0} entries · double-click to rename`)}"><span class="title">${dot}${esc(sessionName(s.id))}</span><span class="meta">${esc(meta)}</span></button>`)
  }
  if (counts['']) rows.push(`<div class="group">Before sessions</div><button class="session-row" data-session="" aria-current="${viewSession === ''}"><span class="name">Earlier work</span><span class="count">${counts['']}</span></button>`)
  const days = data.dates.map(d =>
    `<button data-date="${d.date}" aria-current="${viewSession === null && d.date === data.date}"><span>${esc(d.label)}</span><span class="count">${d.count || ''}</span></button>`).join('')
  $('#days').innerHTML =
    `<h2>Sessions</h2>${rows.join('') || '<div class="hint" style="padding:0 10px">No sessions yet.</div>'}` +
    `<h2 style="margin-top:18px">Days</h2>${days}`
}

let sessionLog = null // { id, days } for the session being viewed
const renderJournal = () => {
  // Live updates wait while you edit, so the editor is not swept away.
  if (editingId) return
  const { day, open, today } = data
  $('#title').textContent = data.meta?.title ?? 'Notepad'
  document.title = `${data.meta?.title ?? 'Notepad'} · Notepad`
  renderNav()
  // The side panel edits like the journal: tick or untick, ✎ or double-click.
  $('#open').innerHTML = open.length ? open.map(n =>
    `<div class="item note-row" data-entry="${esc(n.id)}"><div class="note-body"><input type="checkbox" class="check" data-done="${n.id}" title="Mark done"><div class="note-main">${n.type === 'blocker' ? '⛔ ' : ''}${firstLine(n.text)}<small>${esc(label(n.component))}</small></div><button class="edit-btn" data-edit="${esc(n.id)}" title="Edit">✎</button></div></div>`).join('') : '<div class="hint">Nothing open.</div>'

  if (viewSession !== null) return renderSession()

  const current = data.dates.find(d => d.date === data.date)
  $('#dayTitle').textContent = current?.label ?? data.date
  const entries = [...day.entries].sort((a, b) => b.ts - a.ts)
  const showSession = new Set(entries.map(e => e.session ?? '')).size > 1
  $('#dayMeta').textContent = countLine(entries)
  $('#entries').innerHTML = entries.length ? entries.map(e => entryHtml(e, showSession, data.date)).join('')
    : `<div class="empty">${data.date === today ? 'Nothing logged yet today. Notes you add here, /n in Claude Code, and each Claude turn show up live.' : 'Nothing logged this day.'}</div>`
  renderRail(entries, 'this day')
}

const renderRail = (entries, span) => {
  const completed = entries.filter(e => e.type === 'done')
  $('#completed').innerHTML = completed.length ? completed.map(d => `<div class="item note-row" data-entry="${esc(d.ref)}"><div class="note-body"><input type="checkbox" class="check" data-done="${esc(d.ref)}" checked title="Reopen"><div class="note-main"><span class="struck">${firstLine(d.refText ?? 'an item')}</span><small>${time(d.ts)}${d.refDate && d.refDate !== data.date ? ` · added ${esc(fromDay(d.refDate))}` : ''}</small></div><button class="edit-btn" data-edit="${esc(d.ref)}" title="Edit">✎</button></div></div>`).join('') : `<div class="hint">Nothing completed ${span}.</div>`
  const decisions = entries.filter(e => e.type === 'decision')
  $('#decisions').innerHTML = decisions.length ? decisions.map(d => `<div class="item note-row" data-entry="${esc(d.id)}"><div class="note-body"><span class="icon">◆</span><div class="note-main">${firstLine(d.text)}${d.why ? `<small>because ${inline(d.why)}</small>` : ''}</div><button class="edit-btn" data-edit="${esc(d.id)}" title="Edit">✎</button></div></div>`).join('') : `<div class="hint">None ${span}.</div>`
  const counts = {}
  for (const t of entries.filter(e => e.type === 'turn')) for (const c of t.components) counts[c] = (counts[c] ?? 0) + 1
  $('#components').innerHTML = Object.keys(counts).length ? Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<div class="item"><div>${esc(label(c))}<small>${n} turn${n > 1 ? 's' : ''}</small></div></div>`).join('') : `<div class="hint">No component work ${span}.</div>`
}

// One session's whole history, a heading per day.
const renderSession = async () => {
  const id = viewSession
  const s = sessionById(id)
  $('#dayTitle').textContent = sessionName(id)
  if (!sessionLog || sessionLog.id !== id) $('#entries').innerHTML = '<div class="empty">Loading…</div>'
  const log = await api(`/api/sessionlog?id=${encodeURIComponent(id)}`)
  if (viewSession !== id) return
  sessionLog = log
  const all = log.days.flatMap(d => d.entries)
  const where = s?.folder && s.folder !== data.project ? ` · runs in ${s.folder.split('/').pop()}` : ''
  $('#dayMeta').textContent = `${countLine(all)}${where}${isOpenSession(s) ? ' · open now' : ''}`
  $('#entries').innerHTML = log.days.length ? log.days.map(d => {
    const label = new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    return `<h3 class="dayhead">${esc(label)}</h3>${[...d.entries].sort((a, b) => b.ts - a.ts).map(e => entryHtml(e, false, d.date)).join('')}`
  }).join('') : '<div class="empty">This session has not logged anything in this project yet.</div>'
  renderRail(all, 'in this session')
}

/* ---------- Editing your notes ---------- */

// Your own entries (notes, todos, blockers, decisions) edit in place; the
// journal keeps the change as an event, like done.
let editingId = null
const findEntry = id => {
  const all = [...(data?.day?.entries ?? []), ...(data?.open ?? []), ...(sessionLog?.days ?? []).flatMap(d => d.entries), ...(drawer?.data?.marks ?? [])]
  const found = all.find(e => e.id === id && e.type !== 'done')
  if (found) return found
  // Completed on this day but written on another: rebuilt from its done line.
  const done = all.find(e => e.type === 'done' && e.ref === id && e.refText)
  return done ? { id, type: done.refType ?? 'todo', text: done.refText } : undefined
}
let editingRow = null
const wrapSel = (ta, before, after = before) => {
  const s = ta.selectionStart; const e = ta.selectionEnd
  const sel = ta.value.slice(s, e) || 'text'
  ta.setRangeText(before + sel + after, s, e, 'end')
  ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length
  ta.focus(); ta.dispatchEvent(new Event('input'))
}
const listSel = ta => {
  const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1
  const end = ta.value.indexOf('\n', ta.selectionEnd); const stop = end < 0 ? ta.value.length : end
  const lines = ta.value.slice(start, stop).split('\n')
  const isList = lines.every(l => /^\s*[-*] /.test(l))
  ta.setRangeText(lines.map(l => (isList ? l.replace(/^\s*[-*] /, '') : `- ${l}`)).join('\n'), start, stop, 'select')
  ta.focus(); ta.dispatchEvent(new Event('input'))
}
const linkSel = async ta => {
  const url = await askText({ title: 'Add a link', body: 'The selected text becomes the link.', value: 'https://', ok: 'Add link' })
  if (url && /^https?:\/\//.test(url.trim())) wrapSel(ta, '[', `](${url.trim()})`)
  else ta.focus()
}
const FORMAT = { bold: ta => wrapSel(ta, '**'), italic: ta => wrapSel(ta, '_'), code: ta => wrapSel(ta, '`'), list: listSel, link: linkSel }
// ⌘B bold, ⌘I italic, ⌘E code, ⌘K link, in the editor and the composer.
const formatKeys = (e, ta) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return false
  const f = { b: 'bold', i: 'italic', e: 'code', k: 'link' }[e.key.toLowerCase()]
  if (!f) return false
  e.preventDefault(); FORMAT[f](ta); return true
}
const grow = ta => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px` }
const startEditEntry = (id, at = null) => {
  const e = findEntry(id)
  const row = at ?? document.querySelector(`#entries [data-entry="${CSS.escape(id)}"]`)
  if (!e || !row || !['note', 'todo', 'blocker', 'decision', 'mark'].includes(e.type)) return
  if (editingId && editingId !== id) cancelEdit()
  editingId = id
  editingRow = row
  const body = row.querySelector('.note-body')
  body.innerHTML = `<div class="editbox">
    <div class="fmt"><button data-fmt="bold" title="Bold (⌘B)"><b>B</b></button><button data-fmt="italic" title="Italic (⌘I)"><i>I</i></button><button data-fmt="code" title="Code (⌘E)">‹›</button><button data-fmt="list" title="Bulleted list">• List</button><button data-fmt="link" title="Link (⌘K)">Link</button></div>
    <textarea class="edit-text" rows="1">${esc(e.text)}</textarea>
    ${e.type === 'decision' ? `<input class="edit-why" placeholder="because… (optional)" value="${esc(e.why ?? '')}">` : ''}
    <div class="edit-actions"><button class="btn primary" data-edit-save>Save</button><button class="btn" data-edit-cancel>Cancel</button><span class="hint">⌘↵ save · Esc cancel · Shift↵ new line</span><span class="spacer"></span><button class="btn danger" data-edit-delete>Delete</button></div>
  </div>`
  const ta = body.querySelector('.edit-text')
  grow(ta); ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length
  ta.addEventListener('input', () => grow(ta))
  body.querySelectorAll('textarea, input').forEach(el => el.addEventListener('keydown', ev => {
    ev.stopPropagation()
    if (el === ta && formatKeys(ev, ta)) return
    if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit() }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey || (el !== ta && !ev.shiftKey))) { ev.preventDefault(); saveEdit() }
  }))
}
const cancelEdit = () => { editingId = null; editingRow = null; renderJournal() }
const saveEdit = async () => {
  const id = editingId
  const row = editingRow ?? document.querySelector(`#entries [data-entry="${CSS.escape(id)}"]`)
  const text = row?.querySelector('.edit-text')?.value.trim()
  if (!text) return toast('Write something, or use Delete')
  const why = row.querySelector('.edit-why')?.value
  const res = await api('/api/edit', { ref: id, text, ...(why !== undefined ? { why } : {}) })
  editingId = null
  editingRow = null
  toast(res.ok ? 'Saved' : (res.error ?? 'Could not save'))
  load()
}
const deleteEdit = async () => {
  const e = findEntry(editingId)
  const isSure = await askConfirm({ title: `Delete this ${e?.type ?? 'note'}?`, body: 'It leaves the journal. The change is kept as an event, like an edit.', ok: 'Delete', isDanger: true })
  if (!isSure) return
  const res = await api('/api/remove', { ref: editingId })
  editingId = null
  editingRow = null
  toast(res.ok ? 'Deleted' : (res.error ?? 'Could not delete'))
  load()
}
// The journal and the side panel share one editor: it opens in the row clicked.
for (const area of [$('#entries'), document.querySelector('.rail'), $('#drawer')]) {
  area.addEventListener('click', e => {
    const t = e.target
    const fmt = t.closest('[data-fmt]')
    if (fmt) { const ta = fmt.closest('.editbox').querySelector('.edit-text'); FORMAT[fmt.dataset.fmt](ta); return }
    const edit = t.closest('[data-edit]')
    if (edit) return startEditEntry(edit.dataset.edit, edit.closest('.note-row'))
    if (t.closest('[data-edit-save]')) return saveEdit()
    if (t.closest('[data-edit-cancel]')) return cancelEdit()
    if (t.closest('[data-edit-delete]')) return deleteEdit()
  })
  area.addEventListener('dblclick', e => {
    const row = e.target.closest('.note-row')
    if (row && !e.target.closest('.editbox, a, input')) startEditEntry(row.dataset.entry, row)
  })
}

/* ---------- Search ---------- */

// While the box holds a query, the journal lists matches from every day; a
// match opens its day with the entry highlighted.
let searchQuery = ''
let searchTimer
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const highlight = (text, words) => {
  let html = esc(text)
  for (const w of words) html = html.replace(new RegExp(escapeRe(esc(w)), 'gi'), m => `<mark>${m}</mark>`)
  return html
}
const showSearch = async () => {
  const q = searchQuery
  const { hits, total } = await api(`/api/search?q=${encodeURIComponent(q)}`)
  if (q !== searchQuery) return
  const words = q.split(/\s+/).filter(Boolean)
  $('#dayTitle').textContent = `Search · “${q}”`
  $('#dayMeta').textContent = `${total} match${total === 1 ? '' : 'es'}${total > hits.length ? ` · newest ${hits.length} shown` : ''} · Esc to clear`
  $('#entries').innerHTML = hits.length ? hits.map(h => {
    const day = new Date(h.ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    const kind = h.type === 'turn' ? '' : `<span class="badge">${esc(h.type)}${h.done ? ', done' : ''}</span>`
    const where = h.session ? `<span class="chip session">${esc(sessionName(h.session))}</span>` : ''
    return `<div class="entry hit" data-goto="${esc(h.date)}" data-id="${esc(h.id)}" data-kind="${esc(h.type)}"><time>${day}<br>${time(h.ts)}</time><div><span class="${h.type === 'turn' ? 'what' : 'text'}">${highlight(h.title, words)}</span>${kind}${where}${h.detail ? `<div class="detail">${highlight(h.detail, words)}</div>` : ''}</div></div>`
  }).join('') : '<div class="empty">Nothing in the journal matches. Try fewer or shorter words.</div>'
}
const setSearch = q => {
  searchQuery = q.trim()
  clearTimeout(searchTimer)
  if (!searchQuery) return renderJournal()
  searchTimer = setTimeout(showSearch, 180)
}
$('#search').addEventListener('input', e => setSearch(e.target.value))
$('#search').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.target.value = ''; setSearch(''); e.target.blur() }
  e.stopPropagation()
})
$('#entries').addEventListener('click', async e => {
  const hit = e.target.closest('[data-goto]')
  if (!hit) return
  $('#search').value = ''
  searchQuery = ''
  if (hit.dataset.kind === 'standup') { await setTab('standup'); return showArchived(hit.dataset.id) }
  date = hit.dataset.goto
  viewSession = null
  await load()
  const row = document.querySelector(`[data-entry="${CSS.escape(hit.dataset.id)}"]`)
  if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.classList.add('flash') }
})

/* ---------- Writing a note ---------- */

const setType = next => {
  type = next
  document.querySelectorAll('[data-type]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === type)))
  $('#input').placeholder = { note: 'Jot a note… (@component to tag it)', todo: 'What is left to do…', blocker: 'What is blocking you…', decision: 'Decision… because why' }[type]
}

// @component suggestions while typing a note.
const input = $('#input')
const suggest = $('#suggest')
let choices = []
let chosen = 0
const showSuggest = () => {
  const before = input.value.slice(0, input.selectionStart)
  const m = /(^|\s)@([\w.-]*)$/.exec(before)
  const nodes = data?.meta?.nodes ?? []
  const q = (m?.[2] ?? '').toLowerCase()
  const rank = n => (n.id.startsWith(q) || n.label.toLowerCase().split(/\s+/).some(w => w.startsWith(q)) ? 0 : 1)
  choices = m ? nodes.filter(n => n.id.includes(q) || n.label.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b)).slice(0, 6) : []
  if (!choices.length) { suggest.style.display = 'none'; return }
  chosen = Math.min(chosen, choices.length - 1)
  const box = input.getBoundingClientRect()
  suggest.style.left = `${box.left}px`
  suggest.style.top = `${box.bottom + 6}px`
  suggest.style.display = 'block'
  suggest.innerHTML = choices.map((n, i) => `<button data-pick="${i}" aria-selected="${i === chosen}">${esc(n.label)} <span class="hint">@${esc(n.id)}</span></button>`).join('')
}
const pick = i => {
  const n = choices[i]
  if (!n) return
  const pos = input.selectionStart
  const before = input.value.slice(0, pos).replace(/@([\w.-]*)$/, `@${n.id} `)
  input.value = before + input.value.slice(pos)
  input.selectionStart = input.selectionEnd = before.length
  suggest.style.display = 'none'
  input.focus()
}
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; chosen = 0; showSuggest() })
input.addEventListener('keydown', async e => {
  if (formatKeys(e, input)) return
  if (suggest.style.display === 'block') {
    if (e.key === 'ArrowDown') { chosen = (chosen + 1) % choices.length; showSuggest(); e.preventDefault(); return }
    if (e.key === 'ArrowUp') { chosen = (chosen - 1 + choices.length) % choices.length; showSuggest(); e.preventDefault(); return }
    if (e.key === 'Tab' || e.key === 'Enter') { pick(chosen); e.preventDefault(); return }
    if (e.key === 'Escape') { suggest.style.display = 'none'; return }
  }
  if (e.altKey && /^Digit[1-4]$/.test(e.code)) { setType(['note', 'todo', 'blocker', 'decision'][Number(e.code.slice(-1)) - 1]); e.preventDefault(); return }
  if (e.key === 'Escape') { input.blur(); return }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    input.style.height = 'auto'
    await api('/api/note', { type, text })
    date = data.today
    toast(`Added ${type}`)
    load()
  }
})
suggest.addEventListener('mousedown', e => { const b = e.target.closest('[data-pick]'); if (b) { e.preventDefault(); pick(Number(b.dataset.pick)) } })

// Clicks on the journal's controls, wherever they sit (main.js routes every
// click here first).
const journalClick = async t => {
  if (t.closest('[data-type]')) { setType(t.closest('[data-type]').dataset.type); input.focus() }
  if (t.closest('[data-date]')) { date = t.closest('[data-date]').dataset.date; viewSession = null; load() }
  if (t.closest('[data-session]')) { viewSession = t.closest('[data-session]').dataset.session; renderJournal() }
  if (t.matches('[data-done]') && t.checked) { await api('/api/done', { ref: t.dataset.done }); toast('Done · logged in today’s journal'); if (!t.closest('#entries')) { date = data.today; viewSession = null } load() }
  else if (t.matches('[data-done]') && !t.checked) { await api('/api/undone', { ref: t.dataset.done }); toast('Reopened · back in Open'); load() }
}

$('#days').addEventListener('dblclick', async e => {
  const id = e.target.closest('[data-session]')?.dataset.session
  if (!id) return
  const name = await askText({ title: 'Rename session', body: 'The sidebar, boards and standups use this name.', value: sessionName(id), ok: 'Rename' })
  if (!name?.trim()) return
  const res = await api('/api/session', { id, name: name.trim() })
  if (res.ok) { toast('Renamed'); load() } else toast(res.error ?? 'Could not rename')
})
$('#copyDay').addEventListener('click', async () => {
  const lines = [...data.day.entries].sort((a, b) => a.ts - b.ts).map(e => e.type === 'turn'
    ? `${time(e.ts)} ${e.request}\n${e.summary.map(s => `  - ${s}`).join('\n')}`
    : `${time(e.ts)} [${e.type}${e.done ? ', done' : ''}] ${e.text}${e.why ? ` (because ${e.why})` : ''}`)
  await navigator.clipboard.writeText(`${$('#dayTitle').textContent}\n\n${lines.join('\n')}`)
  toast('Day copied')
})

// A commit row's file list, opened: each file's added and removed lines.
document.addEventListener('toggle', async e => {
  const box = e.target
  if (!(box instanceof HTMLDetailsElement) || !box.open || !box.dataset.commit || box.dataset.loaded) return
  box.dataset.loaded = '1'
  const found = await api(`/api/commit?sha=${encodeURIComponent(box.dataset.commit)}`).catch(() => null)
  if (!found?.files) return
  box.querySelector('.commitfiles').innerHTML = found.files.map(f => `<div><code class="link" data-open="${esc(f.path)}" title="Open in editor">${esc(f.path)}</code> <span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></div>`).join('')
}, true)
