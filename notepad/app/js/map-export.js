/* ---------- Exporting the map ---------- */

// What the map looks like now (open components included), as a standalone
// SVG: the map's own CSS rules inlined with this theme's colors resolved.
const mapStyles = () => {
  const css = []
  for (const sheet of document.styleSheets) {
    let rules = []
    try { rules = [...sheet.cssRules] } catch { continue }
    for (const r of rules) if (r.selectorText?.includes('#map ')) css.push(r.cssText.replaceAll('#map ', ''))
  }
  return css.join('\n').replace(/var\(--([\w-]+)\)/g, (_, v) => cssVar(v) || 'currentColor')
}
const mapSvg = async () => {
  const L = await computeLayout()
  const rs = Object.values(L.nodes)
  const top = Math.min(...rs.map(r => r.y), 40) - 34
  const x0 = Math.min(0, ...rs.map(r => r.x)) - 4
  const pad = 24
  const w = Math.ceil(Math.max(...rs.map(r => r.x + r.w)) - x0 + pad * 2)
  const h = Math.ceil(Math.max(...rs.map(r => r.y + r.h)) - top + pad * 2)
  const title = mapData?.title || data?.meta?.title || 'Architecture'
  return {
    w, h,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0 - pad} ${top - pad} ${w} ${h}" width="${w}" height="${h}" font-family="${esc(cssVar('font') || 'monospace')}"><title>${esc(title)} · architecture</title><style>${mapStyles()}</style><rect x="${x0 - pad}" y="${top - pad}" width="${w}" height="${h}" style="fill:${cssVar('paper')}"/>${mapMarkup(L, true)}</svg>`,
  }
}
const mapPng = async () => {
  const { svg, w, h } = await mapSvg()
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const scale = Math.min(2, 8000 / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale)
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
}

// The map as a Mermaid flowchart: tiers as columns, open components as groups
// of their parts, links ending on the parts that make the call.
const mermaidId = id => String(id).replace(/[^\w]/g, '_')
const mermaidText = t => String(t ?? '').replace(/"/g, '#quot;').replace(/[<>]/g, c => (c === '<' ? '#lt;' : '#gt;'))
const SHAPE = { client: ['([', '])'], edge: ['{{', '}}'], service: ['[', ']'], worker: ['[', ']'], queue: ['[/', '/]'], store: ['[(', ')]'], external: ['[[', ']]'] }
const mapMermaid = () => {
  const title = mapData?.title || data?.meta?.title || 'Architecture'
  const lines = [`%% ${title} · architecture, from arch-live (${new Date().toLocaleDateString()})`, `flowchart ${mapPrefs.mode === 'td' ? 'TD' : 'LR'}`]
  const tiers = TIER_LABEL.map(() => [])
  for (const n of [...mapData.nodes].sort((a, b) => a.order - b.order)) tiers[TIER[n.kind] ?? 2].push(n)
  // Tiers as comments: Mermaid lays out left to right best without tier groups.
  tiers.forEach((nodes, i) => {
    if (!nodes.length) return
    lines.push(`  %% ${TIER_LABEL[i]}`)
    for (const n of nodes) {
      const id = mermaidId(n.id)
      if (openSet.has(n.id) && partsFor(n).parts.length) {
        lines.push(`  subgraph ${id}["${mermaidText(n.label)}"]`, '    direction LR')
        partsFor(n).parts.forEach((p, k) => lines.push(`    ${id}__${mermaidId(p.id)}["${k + 1}. ${mermaidText(p.label)}${p.summary ? `<br/><small>${mermaidText(p.summary)}</small>` : ''}"]`))
        lines.push('  end')
      } else {
        const [a, b] = SHAPE[n.kind] ?? SHAPE.service
        lines.push(`  ${id}${a}"${mermaidText(n.label)}${n.sublabel ? `<br/><small>${mermaidText(n.sublabel)}</small>` : ''}"${b}`)
      }
    }
  })
  const arrow = s => (s === 'async' ? '-.->' : s === 'thin' ? '-.->' : s === 'http' ? '==>' : '-->')
  const end = x => (x.includes('/') ? `${mermaidId(x.slice(0, x.indexOf('/')))}__${mermaidId(x.slice(x.indexOf('/') + 1))}` : mermaidId(x))
  for (const x of linkEnds()) lines.push(`  ${end(x.from)} ${arrow(x.style)}${x.label ? `|"${mermaidText(x.label)}"|` : ''} ${end(x.to)}`)
  for (const n of mapData.nodes) {
    if (!openSet.has(n.id)) continue
    const ids = new Set(partsFor(n).parts.map(p => p.id))
    for (const x of partsFor(n).edges) if (ids.has(x.from) && ids.has(x.to)) lines.push(`  ${mermaidId(n.id)}__${mermaidId(x.from)} --> ${x.label ? `|"${mermaidText(x.label)}"| ` : ''}${mermaidId(n.id)}__${mermaidId(x.to)}`)
  }
  const focus = (mapData.focus ?? []).filter(id => mapData.nodes.some(n => n.id === id))
  if (focus.length) lines.push(`  classDef focus stroke:${cssVar('accent')},stroke-width:2px`, `  class ${focus.map(mermaidId).join(',')} focus`)
  return `${lines.join('\n')}\n`
}

const saveBlob = (name, blob) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
const exportName = ext => `${(mapData?.title || data?.meta?.title || 'architecture').replace(/[^\w-]+/g, '-').toLowerCase()}-architecture.${ext}`
$('#mapExport').addEventListener('click', e => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden })
document.addEventListener('click', e => { if (!e.target.closest('#exportMenu, #mapExport')) $('#exportMenu').hidden = true })
$('#exportMenu').addEventListener('click', async e => {
  const kind = e.target.closest('[data-export]')?.dataset.export
  if (!kind || !mapData) return
  $('#exportMenu').hidden = true
  try {
    if (kind === 'png') saveBlob(exportName('png'), await mapPng())
    if (kind === 'svg') saveBlob(exportName('svg'), new Blob([(await mapSvg()).svg], { type: 'image/svg+xml' }))
    if (kind === 'mmd') saveBlob(exportName('mmd'), new Blob([mapMermaid()], { type: 'text/plain' }))
    if (kind === 'copy') { await navigator.clipboard.writeText(mapMermaid()); return toast('Mermaid copied: paste it in a ```mermaid block') }
    toast(`Exported ${exportName(kind)}`)
  } catch (err) {
    toast(`Could not export: ${err?.message ?? err}`)
  }
})
