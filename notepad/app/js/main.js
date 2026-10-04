// Starts the notepad: loads the day, switches tabs, routes clicks and keys to
// each tab's file, and keeps the live connection. Loaded last.

const load = async () => {
  data = await api(`/api/state${date ? `?date=${date}` : ''}`)
  date = data.date
  applyTheme(data.meta?.theme)
  renderJournal()
  if (searchQuery) showSearch()
  if (tab === 'diagram') { renderDiagram(); if (drawer) openDrawer(drawer.id) }
  if (tab === 'standup') renderStandup()
  if (tab === 'board' && board.underlay) { await loadUnderlay(); drawBoard() }
}

const setTab = async next => {
  tab = next
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
  document.querySelectorAll('[data-view]').forEach(v => v.classList.toggle('on', v.dataset.view === tab))
  $('#app').classList.toggle('wide', tab === 'board' || tab === 'diagram')
  if (tab === 'diagram') renderDiagram()
  if (tab === 'standup') renderStandup()
  if (tab === 'board') {
    renderTools()
    if (!board.id) {
      // This session's latest board, else a new one named after the session.
      const boards = await refreshBoardList()
      const mine = boards.find(b => b.session && b.session === data.self) ?? (data.self ? null : boards[0])
      if (mine) await loadBoard(mine.id)
      else newBoard()
      fit()
    } else drawBoard()
  }
}

document.addEventListener('click', async e => {
  const t = e.target
  if (t.closest('[data-tab]')) return setTab(t.closest('[data-tab]').dataset.tab)
  await journalClick(t)
  boardClick(t)
  if (t.closest('#drawer')) return drawerClick(t)
})

document.addEventListener('keydown', e => {
  if (isTyping(e) || editing) return
  const k = e.key.toLowerCase()
  const mod = e.metaKey || e.ctrlKey
  if (!mod && !e.altKey && /^[1-4]$/.test(k)) return setTab(['journal', 'diagram', 'board', 'standup'][Number(k) - 1])
  if (e.key === 'Escape' && document.querySelector('#settingsModal.on, #helpModal.on')) return closeModals()
  if (e.key === 'Escape' && drawer && tab === 'diagram') return closeDrawer()
  if (tab === 'board') return boardKeys(e, k, mod)
  if (k === 'n') { setTab('journal'); input.focus(); e.preventDefault() }
  if (e.key === '/') { setTab('journal'); $('#search').focus(); e.preventDefault() }
  if (e.key === '?') { openModal('#helpModal'); e.preventDefault() }
  if (e.key === '\\') { togglePane('nav'); e.preventDefault() }
  if (k === '[' || k === ']') {
    const list = data.dates.map(d => d.date)
    const i = list.indexOf(data.date) + (k === '[' ? 1 : -1)
    if (list[i]) { date = list[i]; load() }
  }
})

// The browser retries a dropped stream by itself; the server comes back on the
// same address when a session on the project starts it again.
let wasDown = false
const connect = () => {
  const es = new EventSource(`/events?t=${token}`)
  es.addEventListener('open', () => {
    $('#live').classList.add('on'); $('#liveText').textContent = 'live'
    if (wasDown) { wasDown = false; load(); toast('Reconnected') }
  })
  es.addEventListener('change', () => load())
  es.addEventListener('error', () => {
    wasDown = true
    $('#live').classList.remove('on'); $('#liveText').textContent = 'reconnecting… (open a Claude session on this project)'
  })
}

load().then(connect)
