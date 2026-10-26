// Starts the notepad: loads the day, switches tabs, routes clicks and keys to
// each tab's file, and keeps the live connection. Loaded last.

// In Cursor, "with Claude" and "to Claude" on buttons and hints name Cursor
// instead: its agent runs the request, after you press Enter in its chat.
const relabel = root => {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (/\b(with|to) Claude\b/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/\bwith Claude\b/g, 'in Cursor').replace(/\bto Claude\b/g, 'to Cursor')
  }
}
let relabeling = null
const forHost = host => {
  if (host !== 'cursor' || relabeling) return
  relabel(document.body)
  relabeling = new MutationObserver(changes => { for (const c of changes) for (const node of c.addedNodes) relabel(node) })
  relabeling.observe(document.body, { childList: true, subtree: true })
}

const load = async () => {
  data = await api(`/api/state${date ? `?date=${date}` : ''}`)
  date = data.date
  forHost(data.host)
  applyTheme(data.meta?.theme)
  renderJournal()
  if (searchQuery) showSearch()
  if (tab === 'diagram') { renderDiagram(); if (drawer) openDrawer(drawer.id) }
  if (tab === 'standup') renderStandup()
  if (tab === 'timeline') renderTimeline()
  if (tab === 'insights') renderInsights()
  if (tab === 'board' && board.underlay) { await loadUnderlay(); drawBoard() }
}

const setTab = async next => {
  tab = next
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)))
  document.querySelectorAll('[data-view]').forEach(v => v.classList.toggle('on', v.dataset.view === tab))
  $('#app').classList.toggle('wide', tab === 'board' || tab === 'diagram' || tab === 'timeline' || tab === 'insights')
  if (tab === 'diagram') renderDiagram()
  if (tab === 'insights') renderInsights()
  if (tab === 'standup') renderStandup()
  if (tab === 'timeline') renderTimeline()
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

const showComponent = async id => {
  await setTab('diagram')
  await openDrawer(id)
}
const openFile = async (file, line) => {
  const res = await api('/api/open', { path: file, line: Number(line) || 1 })
  toast(res.ok ? `Opened ${file}` : `Could not open ${file}`)
}

document.addEventListener('click', async e => {
  const t = e.target
  if (t.closest('[data-tab]')) return setTab(t.closest('[data-tab]').dataset.tab)
  // Links between views: a component opens on the diagram, a file in your editor.
  const comp = t.closest('[data-comp]')
  if (comp) return showComponent(comp.dataset.comp)
  const file = !t.closest('#drawer') && t.closest('[data-open]')
  if (file) return openFile(file.dataset.open, file.dataset.line)
  await journalClick(t)
  boardClick(t)
  if (t.closest('[data-view="timeline"]')) return timelineClick(t)
  if (t.closest('#drawer')) return drawerClick(t)
})

document.addEventListener('keydown', e => {
  if (isTyping(e) || editing) return
  const k = e.key.toLowerCase()
  const mod = e.metaKey || e.ctrlKey
  if (!mod && !e.altKey && /^[1-6]$/.test(k)) return setTab(['journal', 'diagram', 'board', 'standup', 'timeline', 'insights'][Number(k) - 1])
  if (e.key === 'Escape' && document.querySelector('#settingsModal.on, #helpModal.on')) return closeModals()
  if (e.key === 'Escape' && tab === 'diagram' && mapFocus.path) return clearPath()
  if (k === '0' && tab === 'diagram' && !mod) return resetMapView()
  if (e.key === 'Escape' && drawer && tab === 'diagram') return closeDrawer()
  if (tab === 'board') return boardKeys(e, k, mod)
  if (tab === 'timeline') timelineKeys(e)
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
