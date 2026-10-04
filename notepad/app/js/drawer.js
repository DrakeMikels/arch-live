/* ---------- The component drawer ---------- */

let drawer = null // { id, data, filter, expanded: Set, details: Map }

const openDrawer = async id => {
  const prev = drawer?.id === id ? drawer : null
  const found = await api(`/api/component?id=${encodeURIComponent(id)}`)
  if (found.error) return toast(found.error)
  drawer = prev ? { ...prev, data: found } : { id, data: found, filter: '', expanded: new Set(), details: new Map(), part: null }
  if (!prev) {
    // Small components open fully; big ones open the folders with today's work.
    const folders = new Set()
    for (const f of found.files) {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        if (found.files.length <= 40 || f.isToday || f.isChanged || f.isEntry) folders.add(dir)
      }
    }
    drawer.expanded = folders
  }
  $('#drawer').classList.add('on')
  renderDrawer()
  if (mapLayout) drawMap(mapLayout)
}

const closeDrawer = () => { drawer = null; $('#drawer').classList.remove('on'); if (mapLayout) drawMap(mapLayout) }

// Folders and files as nested rows; within a folder, today's, changed and
// entry files first.
const buildTree = files => {
  const root = { dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let at = root
    for (const part of parts.slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, { dirs: new Map(), files: [] })
      at = at.dirs.get(part)
    }
    at.files.push(f)
  }
  return root
}
const weight = f => (f.isEntry ? 0 : f.isToday ? 1 : f.isChanged ? 2 : f.summary ? 3 : 4)
const countFiles = node => node.files.length + [...node.dirs.values()].reduce((n, d) => n + countFiles(d), 0)

const renderTree = (node, prefix, depth) => {
  const out = []
  const pad = depth * 14
  for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dir = prefix ? `${prefix}/${name}` : name
    const isOpen = drawer.expanded.has(dir) || !!drawer.filter
    out.push(`<div class="row folder" data-folder="${esc(dir)}" style="padding-left:${pad}px"><span class="name">${isOpen ? '▾' : '▸'} ${esc(name)}/</span><span class="tag">${countFiles(child)}</span></div>`)
    if (isOpen) out.push(renderTree(child, dir, depth + 1))
  }
  for (const f of [...node.files].sort((a, b) => weight(a) - weight(b) || a.path.localeCompare(b.path))) {
    const name = f.path.split('/').pop()
    const detail = drawer.details.get(f.path)
    const sum = f.summary ?? detail?.doc ?? ''
    const tags = [
      f.isEntry ? '<span class="tag">entry</span>' : '',
      f.isToday ? '<span class="tag today">● today</span>' : '',
      f.isChanged && !f.isToday ? '<span class="tag">◦ uncommitted</span>' : '',
      f.isStale ? '<span class="tag" title="Changed since its summary was written">may be out of date</span>' : '',
    ].join('')
    out.push(`<div class="row file${sum ? ' has-sum' : ''}" data-file="${esc(f.path)}" style="padding-left:${pad + 12}px" title="Click for its functions"><span class="name">${esc(name)}</span>${tags}<button class="open" data-open="${esc(f.path)}" title="Open in editor">↗</button></div>`)
    if (sum) out.push(`<div class="sum-line" data-file="${esc(f.path)}" style="padding-left:${pad + 16}px">${esc(sum)}</div>`)
    if (detail?.isOpen) {
      const syms = detail.symbols.filter(s => s.exported || detail.symbols.length <= 12)
      out.push(`<div class="detail" style="margin-left:${pad + 22}px">${detail.doc && f.summary ? `<div class="doc">${esc(detail.doc)}</div>` : ''}${syms.length ? syms.map(s => `<span class="sym" data-open="${esc(f.path)}" data-line="${s.line}">${esc(s.name)} <i>:${s.line}</i></span>`).join('') : '<span class="hint">No top-level functions found.</span>'}<div class="hint">${detail.lines ?? '?'} lines</div></div>`)
    }
  }
  return out.join('')
}

// The component's marks: the open ones first, then the cleared history.
const marksSection = d => {
  const marks = d.marks ?? []
  const row = m => `<div class="note-row mark-row${m.done ? ' done' : ''}" data-entry="${esc(m.id)}"><div class="note-body"><span class="icon">${m.done ? '○' : '◉'}</span><div class="note-main"><div class="text rich">${rich(m.text === '·' ? '(no reason given)' : m.text)}</div><small>${esc(stamp(m.ts))}${m.session ? ` · ${esc(sessionName(m.session))}` : ''}${m.done ? ' · cleared' : ''}${m.editedAt ? ' · edited' : ''}</small></div>${m.done ? `<button class="btn tiny" data-unclear="${esc(m.id)}" title="Show it on the map again">Restore</button>` : `<button class="btn tiny" data-clear="${esc(m.id)}" title="Take it off the map; it stays in the history">Clear</button>`}<button class="edit-btn" data-edit="${esc(m.id)}" title="Edit or delete">✎</button></div></div>`
  const open = marks.filter(m => !m.done)
  const cleared = marks.filter(m => m.done)
  return `<div class="marks" id="drawerMarks"><div class="marks-head"><h3>Marks</h3><button class="btn tiny" id="drawerMarkAdd">+ Add mark</button></div>
    ${open.length ? open.map(row).join('') : '<div class="hint">No open marks. ⌥-click the component on the map, or Add mark.</div>'}
    ${cleared.length ? `<details class="brief"><summary>Cleared (${cleared.length})</summary>${cleared.map(row).join('')}</details>` : ''}</div>`
}

const renderDrawer = () => {
  // A mark being edited in the drawer is not swept away by a live update.
  if (editingId && editingRow && $('#drawer').contains(editingRow)) return
  const d = drawer.data
  const q = drawer.filter.toLowerCase()
  const files = q ? d.files.filter(f => f.path.toLowerCase().includes(q) || (f.summary ?? '').toLowerCase().includes(q)) : d.files
  const missing = d.files.filter(f => !f.summary || f.isStale).length
  const pv = partsFor(mapData?.nodes.find(n => n.id === drawer.id))
  const part = pv.parts.find(x => x.id === drawer.part)
  const n = part ? pv.parts.indexOf(part) + 1 : 0
  const partCard = part ? `<div class="part-card">
      <div class="eyebrow">Part ${n}${part.role ? ` · ${esc(part.role)}` : ''}</div>
      <h3>${esc(part.label)}</h3>
      <div>${inline(part.summary ?? 'No summary yet.')}</div>
      ${part.path ? `<div class="hint" style="margin-top:6px"><code>${esc(part.path)}${part.line ? `:${part.line}` : ''}</code></div>` : ''}
      ${part.detail ? `<div class="md">${md(part.detail)}</div><div class="hint">Explained by Claude · ${esc(stamp(part.detailAt ?? 0))}</div>` : ''}
      <div class="actions">
        ${part.path ? `<button class="btn" data-open="${esc(part.path)}" data-line="${part.line ?? 1}">Open ↗</button>` : ''}
        ${pv.isQuick ? '<span class="hint">Break the component down with Claude to explain its parts in depth.</span>' : `<button class="btn${part.detail ? '' : ' accent'}" data-explain="${esc(part.id)}">${part.detail ? 'Explain again' : 'Explain in depth with Claude'}</button>`}
        <button class="btn" data-part-close>Back to component</button>
      </div>
    </div>` : ''
  $('#drawer').innerHTML = `
    <button class="close" id="drawerClose" title="Close (Esc)">×</button>
    ${partCard}
    <div class="eyebrow">${esc(d.node.kind)}</div>
    <h2>${esc(d.node.label)}</h2>
    <div class="sub">${esc(d.node.sublabel)}</div>
    <div class="sub">Owns: ${d.owns.map(o => `<code>${esc(o)}</code>`).join(' ') || '—'} · ${d.total} file${d.total === 1 ? '' : 's'}${d.truncated ? ' (first 800 shown)' : ''}</div>
    <div class="actions">
      ${d.node.path ? `<button class="btn" data-open="${esc(d.node.path)}" data-line="${d.node.line ?? 1}">Open entry ↗</button>` : ''}
      <button class="btn${missing ? ' accent' : ''}" id="describe" ${missing ? '' : 'disabled'}>${missing ? `Describe ${Math.min(missing, 40)} file${missing === 1 ? '' : 's'} with Claude` : 'All files described'}</button>
      <button class="btn${d.breakdown ? '' : ' accent'}" id="breakdown" title="Claude reads the code and names the component's parts and how they connect">${d.breakdown ? 'Break down again' : 'Break down with Claude'}</button>
    </div>
    ${marksSection(d)}
    <input class="filter" id="drawerFilter" placeholder="Filter files…" value="${esc(drawer.filter)}">
    <div class="tree">${files.length ? renderTree(buildTree(files), '', 0) : '<div class="hint">No files match.</div>'}</div>
    ${d.recent.length ? `<h3 style="margin:22px 0 6px">Recent work</h3><div class="recent">${d.recent.map(r => `<div>${inline(r.request)}<br><small>${new Date(r.ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time(r.ts)}${r.summary ? ` · ${inline(r.summary)}` : ''}</small></div>`).join('')}</div>` : ''}`
  const filter = $('#drawerFilter')
  filter.addEventListener('input', () => { drawer.filter = filter.value; const pos = filter.selectionStart; renderDrawer(); const f = $('#drawerFilter'); f.focus(); f.selectionStart = f.selectionEnd = pos })
}

const toggleFile = async path => {
  const detail = drawer.details.get(path)
  if (detail) { detail.isOpen = !detail.isOpen; return renderDrawer() }
  const found = await api(`/api/symbols?path=${encodeURIComponent(path)}`)
  drawer.details.set(path, { ...found, isOpen: true })
  renderDrawer()
}

const openCode = async (path, line) => {
  const res = await api('/api/open', { path, line: Number(line) || 1 })
  toast(res.ok ? `Opened ${path.split('/').pop()}${line ? `:${line}` : ''}` : 'Could not open the editor')
}

// Marking a component: a short note on why it matters, drawn on the map.
const markComponent = async id => {
  const name = mapData?.nodes.find(n => n.id === id)?.label ?? data?.meta?.nodes?.find(n => n.id === id)?.label ?? id
  const why = await askText({ title: `Mark ${name}`, body: 'Why it matters (optional). It shows above the component on the map and in today\'s journal.', placeholder: 'e.g. webhook retries are flaky', ok: 'Mark' })
  if (why === null) return
  await api('/api/note', { type: 'mark', text: why.trim() || '·', component: id })
  toast('Marked')
}

// Clicks inside the drawer (main.js routes them here).
const drawerClick = async t => {
  const open = t.closest('[data-open]')
  if (open) return openCode(open.dataset.open, open.dataset.line)
  if (t.closest('#drawerClose')) return closeDrawer()
  if (t.closest('#describe')) {
    const res = await api('/api/ask', { kind: 'describe', component: drawer.id })
    return toast(res.ok ? `Asked Claude to describe ${res.files} file${res.files === 1 ? '' : 's'}: they fill in as it works` : 'Could not reach the session')
  }
  if (t.closest('#breakdown')) {
    const res = await api('/api/ask', { kind: 'breakdown', component: drawer.id })
    return toast(res.ok ? 'Asked Claude to break this component down: the diagram fills in when it is done' : 'Could not reach the session')
  }
  const explain = t.closest('[data-explain]')
  if (explain) {
    const res = await api('/api/ask', { kind: 'explain', component: drawer.id, part: explain.dataset.explain })
    return toast(res.ok ? 'Asked Claude to explain this part: it appears here when done' : 'Could not reach the session')
  }
  if (t.closest('[data-part-close]')) { drawer.part = null; renderDrawer(); return renderDiagram() }
  if (t.closest('#drawerMarkAdd')) return markComponent(drawer.id)
  const clear = t.closest('[data-clear]')
  if (clear) { await api('/api/done', { ref: clear.dataset.clear }); toast('Mark cleared: it stays in the history'); return load() }
  const unclear = t.closest('[data-unclear]')
  if (unclear) { await api('/api/undone', { ref: unclear.dataset.unclear }); toast('Mark restored'); return load() }
  const folder = t.closest('[data-folder]')
  if (folder) { const d = folder.dataset.folder; drawer.expanded.has(d) ? drawer.expanded.delete(d) : drawer.expanded.add(d); return renderDrawer() }
  const file = t.closest('[data-file]')
  if (file) return toggleFile(file.dataset.file)
}
