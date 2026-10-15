/* ---------- Insights ---------- */

// The last four weeks at a glance (from /api/insights, built from the
// journal): work, commits and test runs per day, the components and files
// that saw the most work, and how todos and blockers are going. Hover any
// bar for its numbers; Copy as table gives the active days as Markdown.

let insights = null
const CRITICAL = '#c2410c'

const shortDay = date => new Date(`${date}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })
const durationText = ms => {
  const h = ms / 3_600_000
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`
}

// A bar with only its data end rounded, standing on the baseline.
const barPath = (x, y, w, h, r = 3) => {
  if (h <= 0) return ''
  const k = Math.min(r, h, w / 2)
  return `M${x},${y + h}V${y + k}Q${x},${y} ${x + k},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h}Z`
}

// Bars per day. `stack` is one or two series drawn bottom up; each day's tip
// says every number. The x axis names the first, middle and last day only.
const dayBars = ({ days, stack, height = 120, tip, mark }, width) => {
  const W = Math.max(240, Math.round(width)); const top = 18; const bottom = 20; const H = height
  const slot = W / days.length; const bw = Math.min(14, Math.max(4, slot - 6))
  const max = Math.max(1, ...days.map(d => stack.reduce((s, x) => s + (x.value(d) ?? 0), 0)))
  const plot = H - top - bottom
  const out = [`<line x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}" class="i-axis"/>`, `<text x="0" y="10" class="i-tick">${max}</text>`]
  days.forEach((d, i) => {
    const x = i * slot + (slot - bw) / 2
    let base = H - bottom
    stack.forEach((series, k) => {
      const v = series.value(d) ?? 0
      const h = (v / max) * plot
      if (h > 0) out.push(`<path d="${barPath(x, base - h, bw, h, k === stack.length - 1 || !stack.slice(k + 1).some(s => s.value(d)) ? 3 : 0)}" style="fill:${series.color}"/>`)
      base -= h + (h > 0 ? 2 : 0)
    })
    if (mark?.(d)) out.push(`<text x="${x + bw / 2}" y="${Math.max(12, base - 3)}" text-anchor="middle" class="i-flag">✗</text>`)
    if (i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) out.push(`<text x="${x + bw / 2}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}" class="i-tick">${esc(shortDay(d.date))}</text>`)
    out.push(`<rect x="${i * slot}" y="0" width="${slot}" height="${H - bottom}" class="i-hit" data-tip="${esc(tip(d))}"/>`)
  })
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="i-chart" role="img">${out.join('')}</svg>`
}

// Charts are drawn at their card's real width, so text keeps its size; they
// redraw when the tab is resized.
let chartSpecs = []
const chartSlot = spec => { chartSpecs.push(spec); return `<div class="i-plot" data-chart="${chartSpecs.length - 1}"></div>` }
const drawCharts = () => document.querySelectorAll('#insights [data-chart]').forEach(el => { el.innerHTML = dayBars(chartSpecs[Number(el.dataset.chart)], el.clientWidth) })
new ResizeObserver(() => { if (tab === 'insights' && chartSpecs.length) drawCharts() }).observe($('#insights'))

const card = (title, body, extra = '') => `<section class="i-card${extra}"><h3>${title}</h3>${body}</section>`
const tile = (value, labelText, note = '') => `<div class="i-tile"><div class="i-value">${value}</div><div class="i-label">${labelText}</div>${note ? `<div class="hint">${note}</div>` : ''}</div>`

const renderInsights = async () => {
  const next = await api('/api/insights').catch(() => null)
  if (!next || next.error) { $('#insights').innerHTML = '<div class="empty">Could not load insights.</div>'; return }
  insights = next
  const { days, components, files, items, span } = insights
  const sum = k => days.reduce((s, d) => s + d[k], 0)
  const lastRun = [...days].reverse().find(d => d.tests)
  const accent = 'var(--accent)'

  const tiles = [
    tile(sum('turns'), `turns in ${span} days`),
    tile(sum('commits'), 'commits'),
    tile(sum('files'), 'file changes'),
    lastRun
      ? tile(lastRun.tests.failed ? `<span class="i-bad">✗ ${lastRun.tests.failed}</span>` : `✓ ${lastRun.tests.passed}`, lastRun.tests.failed ? `failing, ${lastRun.tests.passed} passed` : 'tests passed', `last run ${shortDay(lastRun.date)}`)
      : tile('—', 'no test runs yet'),
    tile(items.open, 'open todos & blockers', items.avgCloseMs !== undefined ? `close in ${durationText(items.avgCloseMs)} on average` : ''),
  ].join('')

  chartSpecs = []
  const turnsChart = chartSlot({ days, stack: [{ value: d => d.turns, color: accent }], tip: d => `${shortDay(d.date)}: ${d.turns} turn${d.turns === 1 ? '' : 's'}, ${d.files} file change${d.files === 1 ? '' : 's'}` })
  const commitsChart = chartSlot({ days, stack: [{ value: d => d.commits, color: accent }], tip: d => `${shortDay(d.date)}: ${d.commits} commit${d.commits === 1 ? '' : 's'}` })
  const testsChart = chartSlot({
    days,
    height: 140,
    stack: [{ value: d => d.tests?.passed, color: 'var(--link)' }, { value: d => d.tests?.failed, color: CRITICAL }],
    mark: d => d.tests?.failed > 0,
    tip: d => (d.tests ? `${shortDay(d.date)}, last run: ${d.tests.passed} passed${d.tests.failed ? `, ✗ ${d.tests.failed} failed` : ''}` : `${shortDay(d.date)}: no test run`),
  })
  const legend = `<div class="i-legend"><span><i style="background:var(--link)"></i>Passed</span><span><i style="background:${CRITICAL}"></i>✗ Failed</span></div>`

  const ranked = Object.entries(components).filter(([, c]) => c.turns).sort((a, b) => b[1].turns - a[1].turns).slice(0, 8)
  const most = Math.max(1, ...ranked.map(([, c]) => c.turns))
  const compRows = ranked.length
    ? ranked.map(([id, c]) => `<div class="i-row link" data-comp="${esc(id)}" data-tip="${esc(`${label(id)}: ${c.turns} turn${c.turns === 1 ? '' : 's'}, last ${agoText(c.lastAt)}${c.uncommitted.length ? `, ${c.uncommitted.length} file${c.uncommitted.length > 1 ? 's' : ''} not committed` : ''}`)}"><span class="i-name">${esc(label(id))}</span><span class="i-bar"><i style="width:${(c.turns / most) * 100}%"></i></span><span class="i-num">${c.turns}</span></div>`).join('')
    : '<div class="hint">No component work logged yet.</div>'
  const fileRows = files.length
    ? files.map(f => `<div class="i-file"><code class="link" data-open="${esc(f.path)}" title="Open in editor">${esc(f.path)}</code><span class="hint">${f.edits} edit${f.edits === 1 ? '' : 's'} · ${f.turns} turn${f.turns === 1 ? '' : 's'}</span></div>`).join('')
    : '<div class="hint">No files changed yet.</div>'
  const oldest = items.oldest.length
    ? items.oldest.map(o => `<div class="i-file"><span>${ICON[o.type] ?? '•'} ${inline(o.text)}</span><span class="hint">open ${durationText(Date.now() - o.ts)}</span></div>`).join('')
    : '<div class="hint">Nothing open.</div>'

  $('#insights').innerHTML = `
    <div class="i-head"><h2>Last ${span} days</h2><span class="spacer"></span><button class="btn" id="insightsCopy">Copy as table</button></div>
    <div class="i-tiles">${tiles}</div>
    <div class="i-grid">
      ${card('Turns per day', turnsChart)}
      ${card('Commits per day', commitsChart)}
      ${card('Tests: each day’s last run', legend + testsChart, ' wide')}
      ${card('Most worked-on components', compRows)}
      ${card('Files changed most', fileRows)}
      ${card('Oldest open todos and blockers', oldest)}
    </div>`
  $('#insightsCopy').addEventListener('click', copyInsights)
  drawCharts()
}

// The numbers behind the charts as a Markdown table: every day that had any
// work, commit or test run (— where there was no test run), then the totals.
const copyInsights = async () => {
  if (!insights) return
  const active = insights.days.filter(d => d.turns || d.commits || d.files || d.tests)
  if (!active.length) return toast(`Nothing logged in the last ${insights.span} days`)
  const cell = (d, k) => (d.tests ? String(d.tests[k]) : '—')
  const rows = active.map(d => `| ${d.date} | ${d.turns} | ${d.files} | ${d.commits} | ${cell(d, 'passed')} | ${cell(d, 'failed')} |`)
  const sum = k => insights.days.reduce((s, d) => s + d[k], 0)
  const last = [...active].reverse().find(d => d.tests)
  const total = `| **Last ${insights.span} days** | **${sum('turns')}** | **${sum('files')}** | **${sum('commits')}** | ${last ? `**${last.tests.passed}** (last run)` : '—'} | ${last ? `**${last.tests.failed}**` : '—'} |`
  const text = ['| Day | Turns | File changes | Commits | Tests passed | Tests failed |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...rows, total].join('\n')
  try { await navigator.clipboard.writeText(text); toast(`Copied ${active.length} day${active.length === 1 ? '' : 's'} as a table`) } catch { toast('Could not copy') }
}

// One tooltip for every [data-tip] in the tab, following the pointer.
const tipBox = document.createElement('div')
tipBox.className = 'i-tip'
document.body.append(tipBox)
$('#insights').addEventListener('pointermove', e => {
  const at = e.target.closest('[data-tip]')
  if (!at) { tipBox.classList.remove('on'); return }
  tipBox.textContent = at.dataset.tip
  tipBox.classList.add('on')
  const x = Math.min(e.clientX + 14, innerWidth - tipBox.offsetWidth - 8)
  tipBox.style.transform = `translate(${x}px, ${e.clientY + 14}px)`
})
$('#insights').addEventListener('pointerleave', () => tipBox.classList.remove('on'))
