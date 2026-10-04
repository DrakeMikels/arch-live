/* ---------- Standup ---------- */

// Current: Claude's latest write-up on top, earlier drafts and the journal
// brief under it. History: every archived standup, newest first by month.
let standupCopy = ''
let standupView = 'current'
let openStandup = null
const longDay = ms => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
const stamp = ms => `${longDay(ms)} ${time(ms)}`
const downloadMd = (name, text) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
const archiveMd = a => `# Standup · ${a.title} · ${longDay(a.at)}\n_${stamp(a.since)} → ${stamp(a.until)} · ${a.scope}_\n\n${a.written ?? a.brief}\n`

const renderStandup = async () => {
  document.querySelectorAll('[data-sview]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sview === standupView)))
  $('#standupCurrent').hidden = standupView !== 'current'
  $('#standupHistory').hidden = standupView !== 'history'
  const cur = await api('/api/standup')
  $('#historyCount').textContent = cur.archivedCount ? `(${cur.archivedCount})` : ''
  if (standupView === 'history') return renderHistory()
  $('#standup').innerHTML = md(cur.markdown)
  // The sessions in this standup's window, named as in the sidebar.
  const pick = $('#standupScope')
  const chosen = pick.value
  const inWindow = sidebarSessions()
  pick.innerHTML = `<option value="">All sessions</option>${inWindow.map(s => `<option value="${esc(s.id)}">${esc(sessionName(s.id))}${s.id === data.self ? ' (this one)' : ''}</option>`).join('')}`
  pick.value = inWindow.some(s => s.id === chosen) ? chosen : ''
  pick.style.display = inWindow.length > 1 || (inWindow.length === 1 && inWindow[0].id !== data.self) ? '' : 'none'
  $('#window').textContent = `Covers ${stamp(cur.since)} → now`
  const w = cur.written
  $('#written').innerHTML = w?.markdown
    ? `<div class="written"><div class="stamp">Written by Claude · ${esc(w.scope ?? 'all sessions')} · ${stamp(w.at)}</div><div class="md">${md(w.markdown)}</div></div>`
    : '<div class="hint" style="margin-bottom:14px">Click <b>Write with Claude</b> for meeting-ready notes: accomplished, in progress, blockers, next.</div>'
  $('#drafts').innerHTML = cur.drafts.length
    ? `<details class="brief"><summary>Earlier drafts (${cur.drafts.length})</summary>${cur.drafts.map(d => `<div class="written"><div class="stamp">${esc(d.scope ?? 'all sessions')} · ${stamp(d.at)}</div><div class="md">${md(d.markdown)}</div></div>`).join('')}</details>`
    : ''
  $('#briefBox').open = !w?.markdown
  standupCopy = w?.markdown ?? cur.markdown
}

const renderHistory = async () => {
  const { standups } = await api('/api/standups')
  if (!standups.length) {
    $('#standupHistory').innerHTML = '<div class="empty">No archived standups yet. After your meeting, <b>Archive &amp; start fresh</b> saves the standup here.</div>'
    return
  }
  const rows = []
  let month = ''
  for (const a of standups) {
    const m = new Date(a.at).toLocaleDateString([], { month: 'long', year: 'numeric' })
    if (m !== month) { month = m; rows.push(`<div class="hist-month">${esc(m)}</div>`) }
    rows.push(`<button class="hist-row" data-standup="${esc(a.id)}" aria-expanded="${openStandup?.id === a.id}"><span class="when">${esc(stamp(a.at))}</span><span class="what">${esc(a.scope)} · ${esc(longDay(a.since))} → ${esc(longDay(a.until))}${a.hasWritten ? '' : ' · journal brief only'}${a.drafts ? ` · ${a.drafts} earlier draft${a.drafts > 1 ? 's' : ''}` : ''}</span></button>`)
    if (openStandup?.id === a.id) {
      const o = openStandup
      rows.push(`<div class="hist-body"><div class="written"><div class="stamp">${o.written ? `Written by Claude · ${esc(stamp(o.writtenAt ?? o.at))}` : 'Journal brief'} · ${esc(o.scope)}</div><div class="md">${md(o.written ?? o.brief)}</div><div class="actions"><button class="btn primary" data-copy-standup>Copy</button><button class="btn" data-download-standup>Download .md</button></div></div>${o.written ? `<details class="brief"><summary>Journal brief at the time</summary><div class="md">${md(o.brief)}</div></details>` : ''}${o.drafts?.length ? `<details class="brief"><summary>Earlier drafts (${o.drafts.length})</summary>${o.drafts.map(d => `<div class="written"><div class="stamp">${esc(stamp(d.at))}</div><div class="md">${md(d.markdown)}</div></div>`).join('')}</details>` : ''}</div>`)
    }
  }
  $('#standupHistory').innerHTML = rows.join('')
}
const showArchived = async id => {
  standupView = 'history'
  openStandup = openStandup?.id === id ? null : await api(`/api/standups/one?id=${encodeURIComponent(id)}`)
  if (openStandup?.error) openStandup = null
  renderStandup()
}
document.addEventListener('click', e => {
  const v = e.target.closest('[data-sview]')
  if (v) { standupView = v.dataset.sview; renderStandup(); return }
  const row = e.target.closest('[data-standup]')
  if (row) return showArchived(row.dataset.standup)
  if (e.target.closest('[data-copy-standup]') && openStandup) {
    navigator.clipboard.writeText(openStandup.written ?? openStandup.brief).then(() => toast('Standup copied'))
  }
  if (e.target.closest('[data-download-standup]') && openStandup) downloadMd(`standup-${openStandup.id}.md`, archiveMd(openStandup))
})
$('#writeStandup').addEventListener('click', async () => {
  const one = $('#standupScope').value
  const res = await api('/api/ask', { kind: 'standup', ...(one ? { session: one } : {}) })
  toast(res.ok ? 'Asked Claude to write your standup: it appears here when done' : 'Could not reach the session')
})

$('#copyStandup').addEventListener('click', async () => { await navigator.clipboard.writeText(standupCopy); toast('Standup copied') })
$('#given').addEventListener('click', async () => {
  const res = await api('/api/standup/given', {})
  if (!res.ok) return toast(res.error ?? 'Could not archive, so nothing was reset')
  toast('Archived to History · the next standup starts from now')
  renderStandup()
})
