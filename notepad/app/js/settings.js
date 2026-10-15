/* ---------- Settings and help ---------- */

const openModal = id => { $(id).classList.add('on') }
const closeModals = () => document.querySelectorAll('#settingsModal, #helpModal').forEach(m => m.classList.remove('on'))
document.addEventListener('click', e => {
  if (e.target.closest('[data-close-modal]') || e.target.matches('#settingsModal, #helpModal')) closeModals()
})
const kb = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
let settingsDays = null

const renderSettings = async () => {
  const st = await api(`/api/settings${settingsDays !== null ? `?days=${settingsDays}` : ''}`)
  const days = settingsDays ?? st.user.retention.snapshots
  const th = data?.meta?.theme ?? {}
  const rows = [['journal', 'Journal days'], ['boards', 'Boards'], ['snapshots', 'Board images sent to Claude'], ['standups', 'Archived standups'], ['sessions', 'Sessions and inboxes'], ['other', 'Map, settings and other']]
  const total = Object.values(st.storage).reduce((n, k) => n + k.bytes, 0)
  const plan = st.plan
  $('#settingsBody').innerHTML = `
    <section><h4>Appearance</h4><div class="row"><span class="seg">${['auto', 'light', 'dark'].map(m => `<button data-setmode="${m}" aria-pressed="${viewMode === m}">${MODES[m]}</button>`).join('')}</span><span class="hint">Kept in this browser. The ◐ button in the header does the same.</span></div></section>
    <section><h4>Diagram style</h4>
      <div class="row"><b>${esc(th.name || 'Editorial default')}</b>${th.source ? `<span class="hint">from ${esc(th.source)}</span>` : ''}</div>
      <div class="row"><button class="btn" id="styleChange">Change style…</button><button class="btn" id="styleReset">Reset to default</button><span class="hint">Your style is used in every repo. Claude reads the site's colors; your fonts stay JetBrains Mono.</span></div></section>
    <section><h4>Storage</h4>
      <table>${rows.map(([k, label]) => `<tr><td>${label}</td><td class="num">${st.storage[k].count} file${st.storage[k].count === 1 ? '' : 's'}</td><td class="num">${kb(st.storage[k].bytes)}</td></tr>`).join('')}<tr><td><b>Total</b></td><td></td><td class="num"><b>${kb(total)}</b></td></tr></table></section>
    <section><h4>Cleanup</h4>
      <div class="row">Remove board images sent to Claude after <select id="retDays">${[[0, 'never'], [30, '30 days'], [90, '90 days'], [180, '180 days']].map(([v, l]) => `<option value="${v}" ${days === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="hint"><input type="checkbox" id="retAuto" ${st.user.retention.autoClean ? 'checked' : ''}> clean up every day</label></div>
      <div class="hint">Cleanup also removes closed sessions that never logged anything, and empty inboxes. It never removes journal days, boards or archived standups.</div>
      <div class="row"><span>${plan.count ? `Would remove ${plan.count} file${plan.count === 1 ? '' : 's'} (${kb(plan.bytes)}): ${Object.entries(plan.byKind).map(([k, n]) => `${n} ${{ snapshot: 'board image', session: 'empty session', inbox: 'empty inbox' }[k]}${n === 1 ? '' : 's'}`).join(', ')}` : 'Nothing to clean up.'}</span>${plan.count ? '<button class="btn" id="cleanNow">Clean up now</button>' : ''}</div></section>
    <section><h4>Map check</h4>
      <div class="hint">Folders the map check ignores in this project (add one from the map's ⚠ menu).</div>
      <div class="row">${st.project.ignoreFolders.length ? st.project.ignoreFolders.map(f => `<span class="chip">${esc(f)}/<button data-unignore="${esc(f)}" title="Check it again">×</button></span>`).join('') : '<span class="hint">None.</span>'}</div></section>
    <section><h4>About</h4><dl>
      <dt>Notepad address</dt><dd><code class="path">${esc(st.address)}</code> <button class="btn tiny" id="copyAddress">Copy</button></dd>
      <dt>This project</dt><dd><code class="path">${esc(st.paths.project)}</code></dd>
      <dt>Journal folder</dt><dd><code class="path">${esc(st.paths.logs)}</code></dd>
      <dt>Your settings</dt><dd><code class="path">${esc(st.paths.home)}</code></dd>
      <dt>Version</dt><dd>arch-live ${esc(st.version)}</dd></dl></section>`
  $('#settingsBody').dataset.address = st.address
}
const saveRetention = async () => {
  await api('/api/settings', { retention: { snapshots: Number($('#retDays').value), autoClean: $('#retAuto').checked } })
}
$('#settingsBtn').addEventListener('click', async () => { settingsDays = null; await renderSettings(); openModal('#settingsModal') })
$('#settingsBody').addEventListener('change', async e => {
  if (e.target.id === 'retDays' || e.target.id === 'retAuto') { settingsDays = Number($('#retDays').value); await saveRetention(); renderSettings() }
})
$('#settingsBody').addEventListener('click', async e => {
  const t = e.target
  const m = t.closest('[data-setmode]')
  if (m) { viewMode = m.dataset.setmode; try { localStorage.setItem('arch-live-mode', viewMode) } catch {} applyTheme(); modeChanged(); return renderSettings() }
  if (t.closest('#styleChange')) {
    const url = await askText({ title: 'Change diagram style', body: 'Claude reads this website\'s colors and makes them your diagram style, for every repo.', placeholder: 'e.g. stripe.com', ok: 'Use this site' })
    if (!url?.trim()) return
    const res = await api('/api/ask', { kind: 'brand', url: url.trim() })
    return toast(res.ok ? 'Asked Claude to read that site\'s colors: the style changes when it is done' : 'Enter a website address, like stripe.com')
  }
  if (t.closest('#styleReset')) {
    if (!(await askConfirm({ title: 'Reset the diagram style?', body: 'Back to the editorial default, in every repo.', ok: 'Reset' }))) return
    const res = await api('/api/ask', { kind: 'theme-default' })
    return toast(res.ok ? 'Resetting the style' : 'Could not reach the session')
  }
  if (t.closest('#cleanNow')) {
    const days = Number($('#retDays').value)
    if (!(await askConfirm({ title: 'Clean up now?', body: 'Removes the files listed. Journal days, boards and archived standups are kept.', ok: 'Clean up', isDanger: true }))) return
    const res = await api('/api/cleanup', { days })
    toast(res.ok ? `Removed ${res.removed} file${res.removed === 1 ? '' : 's'} (${kb(res.bytes)})` : 'Could not clean up')
    return renderSettings()
  }
  const un = t.closest('[data-unignore]')
  if (un) {
    const st = await api('/api/settings')
    await api('/api/settings', { ignoreFolders: st.project.ignoreFolders.filter(f => f !== un.dataset.unignore) })
    renderSettings(); return loadDrift()
  }
  if (t.closest('#copyAddress')) { await navigator.clipboard.writeText($('#settingsBody').dataset.address); toast('Address copied: bookmark it to reopen the notepad') }
})

// Help: what each part does and every shortcut.
const HELP = [
  ['Journal', 'Every Claude turn, with its summary in plain STE English, and your own notes, todos, blockers and decisions. Click a session in the sidebar for its whole history. Tick, untick, edit (✎ or double-click) here or in the right panel. Search every day from the box, or press /.'],
  ['Diagram', 'The live map of the repo. Click a component to open it in place and see its parts; click a numbered part for its purpose and Explain in depth. ⌥-click marks a component; marks stay until cleared in the drawer. Pick a layout, or unlock to drag components and bend lines into your own arrangement. Export as PNG, SVG or Mermaid. ⚠ means the map may be out of date. The overlay menu tints components by recent activity, files not committed, or their last test run; hovering a component fades what it does not touch. Component chips and file names in the journal link here and to your editor.'],
  ['Board', 'A whiteboard: pen, shapes, arrows, text, code blocks and sticky notes, optionally over the diagram. Send to Claude gives Claude the picture and the exact text, in this session or another open one.'],
  ['Standup', 'Write with Claude turns the journal into meeting notes for all sessions or one. Copy for Slack, then Archive & start fresh after the meeting; History keeps every standup.'],
  ['Insights', 'The last four weeks: turns, commits and each day’s last test run, the components and files that saw the most work, and how long todos and blockers stay open. Hover a bar for its numbers; Copy as table gives every day as Markdown.'],
  ['Timeline', 'How the map changed, day by day: what each day added, removed, renamed or rewired, and the turns that did it. Steps marked outside a session are changes made between days (a pull, a merge or an edit by hand). Choose a step to see the map after it.'],
]
const KEYS = [
  ['1 – 6', 'Journal, Diagram, Board, Standup, Timeline, Insights'], ['⌘K', 'Go to a component, day, standup or file, or run an action (outside a note)'],
  ['Diagram: ⇧-click two', 'Light the path between two components (or Path to… in its panel; Esc clears)'], ['Diagram: 0', 'Reset view: clear the path, close the panel, fit the map'], ['N', 'Write a note'], ['/', 'Search the journal'], ['⌥1 – ⌥4', 'Note, todo, blocker, decision'],
  ['@', 'Tag a component in a note'], ['⌘B ⌘I ⌘E ⌘K', 'Bold, italic, code, link'], ['⌘↵', 'Save an edit'], ['Esc', 'Cancel, close'],
  ['\\', 'Hide or show the sidebar'], ['[  ]', 'Previous or next day'], ['↑ ↓', 'Timeline: previous or next step'], ['?', 'This help'],
  ['Board: V H P R O A L T C N E', 'Select, pan, pen, rectangle, ellipse, arrow, line, text, code, sticky, eraser'], ['Board: ⌘Z ⇧⌘Z ⌘D F', 'Undo, redo, duplicate, fit'],
]
$('#helpBody').innerHTML = `${HELP.map(([t, d]) => `<section><h4>${t}</h4><div>${esc(d)}</div></section>`).join('')}<section><h4>Shortcuts</h4><table>${KEYS.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table></section><section><h4>In Claude Code</h4><div>/arch shows the pane · /notepad opens this page · /n, /todo, /blocker, /decision add to the journal · /done closes one · /standup copies your standup · /arch-map re-maps · /arch-theme changes the style · /arch-export writes the diagram as SVG.</div></section>`
$('#helpBtn').addEventListener('click', () => openModal('#helpModal'))
