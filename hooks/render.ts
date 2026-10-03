import type { ArchEdge, ArchGraph, ArchKind, ArchNode, ArchPalette, ArchTheme } from '../types'

import { alpha } from './theme'

// Tiers follow the flow, as diagram-design's architecture type asks: one
// primary direction, grouped by tier. Empty tiers are not drawn.
const TIERS: { kinds: ArchKind[]; label: string }[] = [
  { kinds: ['client'], label: 'CLIENTS' },
  { kinds: ['edge'], label: 'EDGE' },
  { kinds: ['service', 'worker'], label: 'SERVICES' },
  { kinds: ['queue'], label: 'MESSAGING' },
  { kinds: ['store'], label: 'DATA' },
  { kinds: ['external'], label: 'EXTERNAL' },
]

// Every coordinate on the 4px grid.
const MARGIN = 32
const TITLE_H = 60
const HEAD_H = 24
const NODE_H = 64
const LANE = 8
// Room on both sides of the body, across the flow, for corridors.
const PAD = 24
// Between the rows of one tier wrapped onto several lines.
const WRAP_GAP = 40

const TYPE = { title: 24, meta: 9, eyebrow: 8, name: 14, sub: 10, label: 9 }
const ADVANCE = { name: TYPE.name * 0.6, sub: TYPE.sub * 0.62, eyebrow: TYPE.eyebrow * 0.8 }

export type Orientation = 'horizontal' | 'vertical'

// Gaps along the flow (between tiers) and across it (between siblings).
const GAPS: Record<Orientation, { along: number; across: number }> = {
  horizontal: { along: 96, across: 24 },
  vertical: { along: 76, across: 20 },
}

const grid = (n: number) => Math.ceil(n / 4) * 4
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

type Roles = Record<string, string>

const roles = (p: ArchPalette): Roles => ({
  ...p,
  storeFill: alpha(p.ink, 0.05),
  extFill: alpha(p.ink, 0.03),
  extStroke: alpha(p.ink, 0.3),
  clientFill: alpha(p.muted, 0.1),
  queueStroke: alpha(p.ink, 0.35),
  tierInk: alpha(p.ink, 0.45),
})

type Shape = { fill: string; stroke: string; dash?: string }

const shape = (node: ArchNode, isFocal: boolean): Shape => {
  if (isFocal) return { fill: 'accentTint', stroke: 'accent' }
  switch (node.kind) {
    case 'store':
      return { fill: 'storeFill', stroke: 'muted' }
    case 'external':
      return { fill: 'extFill', stroke: 'extStroke' }
    case 'client':
      return { fill: 'clientFill', stroke: 'soft' }
    case 'queue':
      return { fill: 'nodeFill', stroke: 'queueStroke', dash: '4,3' }
    default:
      return { fill: 'nodeFill', stroke: 'ink' }
  }
}

const nodeWidth = (n: ArchNode) =>
  grid(
    Math.min(
      248,
      Math.max(
        128,
        n.label.length * ADVANCE.name + 32,
        (n.sublabel?.length ?? 0) * ADVANCE.sub + 32,
        n.kind.length * ADVANCE.eyebrow + 32,
      ),
    ),
  )

type Point = [number, number]

// Orthogonal polyline through `points`, every corner rounded to r<=8.
const ortho = (raw: Point[]): string => {
  const points = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1]![0] || p[1] !== raw[i - 1]![1])
  const kept = points.filter((p, i) => {
    if (i === 0 || i === points.length - 1) return true
    const a = points[i - 1]!
    const b = points[i + 1]!
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]))
  })
  const out = [`M ${kept[0]![0]},${kept[0]![1]}`]
  for (let i = 1; i < kept.length - 1; i++) {
    const [px, py] = kept[i - 1]!
    const [cx, cy] = kept[i]!
    const [nx, ny] = kept[i + 1]!
    const r = Math.min(8, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2)
    out.push(
      `L ${cx - Math.sign(cx - px) * r},${cy - Math.sign(cy - py) * r}`,
      `Q ${cx},${cy} ${cx + Math.sign(nx - cx) * r},${cy + Math.sign(ny - cy) * r}`,
    )
  }
  const last = kept[kept.length - 1]!
  out.push(`L ${last[0]},${last[1]}`)
  return out.join(' ')
}

// Spreads several values around a centre, `step` apart, within `limit`.
const spread = (count: number, index: number, step: number, limit: number) =>
  Math.max(-limit, Math.min(limit, (index - (count - 1) / 2) * step))

// A node placed in flow coordinates: u runs along the flow, v across it.
type Placed = ArchNode & { tier: number; u0: number; u1: number; v0: number; v1: number }

export type Drawing = { svg: string; alt: string; width: number; height: number; orientation: Orientation }

/** What is drawn over the map: today's marks (component → note) and where Claude is working. */
export type Overlay = { marks?: Record<string, string>; active?: string[]; ids?: boolean }

// A small deterministic wobble, so a mark looks drawn by hand but stays put.
const wobble = (seed: string, i: number) => {
  let h = 2166136261
  for (const c of `${seed}:${i}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return ((h >>> 0) % 1000) / 1000 - 0.5
}

// A hand-drawn loop around a box: an ellipse that overshoots its start.
const sketchLoop = (id: string, x: number, y: number, w: number, h: number) => {
  const cx = x + w / 2
  const cy = y + h / 2
  const rx = w / 2 + 14
  const ry = h / 2 + 12
  const points: string[] = []
  const steps = 26
  for (let i = 0; i <= steps + 3; i++) {
    const t = (i / steps) * Math.PI * 2 - 0.6
    const r = 1 + wobble(id, i) * 0.06
    points.push(`${(cx + Math.cos(t) * rx * r).toFixed(1)},${(cy + Math.sin(t) * ry * r).toFixed(1)}`)
  }
  return `M ${points[0]} ${points.slice(1).map(p => `L ${p}`).join(' ')}`
}

const layout = (graph: ArchGraph | null, theme: ArchTheme, orientation: Orientation, perLine = 0, overlay: Overlay = {}): Drawing => {
  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []
  const focus = new Set(graph?.focus ?? [])
  const isVertical = orientation === 'vertical'
  const gap = GAPS[orientation]
  const primary = theme.mode === 'dark' ? theme.dark : theme.light
  const base = roles(primary)
  const v = (role: string) => `var(--${role},${base[role] ?? '#000'})`
  const f = theme.fonts

  // Vertical layouts wrap a tier wider than `perLine` onto several rows; each
  // row routes as a tier of its own, only the first one labelled.
  const tiers = TIERS.flatMap(tier => {
    const members = nodes.filter(n => tier.kinds.includes(n.kind)).sort((a, b) => a.order - b.order)
    const per = isVertical && perLine > 0 ? perLine : Math.max(1, members.length)
    const rows = []
    for (let i = 0; i < members.length; i += per) {
      rows.push({ label: tier.label, isFirst: i === 0, nodes: members.slice(i, i + per), u0: 0, size: 0, gapBefore: 0 })
    }
    return rows
  })

  // Horizontal: a tier is a column as wide as its widest node, each node
  // NODE_H across. Vertical: a tier is a row NODE_H tall, each node its width.
  const across = (n: ArchNode) => (isVertical ? nodeWidth(n) : NODE_H)
  let cursor = 0
  tiers.forEach((t, i) => {
    t.size = isVertical ? NODE_H : Math.max(...t.nodes.map(nodeWidth))
    t.gapBefore = i === 0 ? 0 : t.isFirst ? gap.along : WRAP_GAP
    cursor += t.gapBefore
    t.u0 = cursor
    cursor += t.size
  })
  const alongLen = cursor
  const gapBefore = (tier: number) => tiers[tier]?.gapBefore ?? gap.along
  const gapAfter = (tier: number) => tiers[tier + 1]?.gapBefore ?? gap.along
  const laneLimit = (g: number) => Math.max(0, g / 2 - 12)
  const tierLen = (t: (typeof tiers)[number]) =>
    t.nodes.reduce((sum, n) => sum + across(n), 0) + (t.nodes.length - 1) * gap.across
  const acrossLen = Math.max(0, ...tiers.map(tierLen))

  const placed = new Map<string, Placed>()
  tiers.forEach((t, tier) => {
    let at = grid((acrossLen - tierLen(t)) / 2)
    for (const n of t.nodes) {
      const size = across(n)
      placed.set(n.id, { ...n, tier, u0: t.u0, u1: t.u0 + t.size, v0: at, v1: at + size })
      at += size + gap.across
    }
  })

  const bx = MARGIN
  const by = MARGIN + TITLE_H + HEAD_H
  const toXY = ([u, w]: Point): Point => (isVertical ? [bx + PAD + w, by + u] : [bx + u, by + PAD + w])
  const loopRoom = 32
  const titleW = (graph?.title ?? 'System architecture').length * TYPE.title * 0.6 + 2 * MARGIN
  const width = grid(Math.max(360, titleW, bx + (isVertical ? acrossLen + 2 * PAD : alongLen + loopRoom) + MARGIN))
  const height = grid(nodes.length ? by + (isVertical ? alongLen + loopRoom : acrossLen + 2 * PAD) + MARGIN : by + 80)

  type Route = { edge: ArchEdge; s: Placed; d: Placed; sEnd: 0 | 1; dEnd: 0 | 1; gap: string; mid: number }
  const routes: Route[] = []
  for (const edge of edges) {
    const s = placed.get(edge.from)
    const d = placed.get(edge.to)
    if (!s || !d || s.id === d.id) continue
    if (s.tier < d.tier) routes.push({ edge, s, d, sEnd: 1, dEnd: 0, gap: `g${d.tier - 1}`, mid: d.u0 - gapBefore(d.tier) / 2 })
    else if (s.tier > d.tier) routes.push({ edge, s, d, sEnd: 0, dEnd: 1, gap: `g${d.tier}`, mid: d.u1 + gapAfter(d.tier) / 2 })
    else routes.push({ edge, s, d, sEnd: 1, dEnd: 1, gap: `loop${s.tier}`, mid: s.u1 + 20 })
  }

  // Ports: endpoints sharing a node face spread out, ordered by the far end.
  const ports = new Map<string, Route[]>()
  const portKey = (id: string, end: number) => `${id}:${end}`
  for (const r of routes) {
    for (const key of [portKey(r.s.id, r.sEnd), portKey(r.d.id, r.dEnd)]) ports.set(key, [...(ports.get(key) ?? []), r])
  }
  const portV = (r: Route, which: 's' | 'd') => {
    const node = r[which]
    const list = ports.get(portKey(node.id, which === 's' ? r.sEnd : r.dEnd)) ?? [r]
    const far = (x: Route) => (x.s.id === node.id ? x.d.v0 : x.s.v0)
    const sorted = [...list].sort((a, b) => far(a) - far(b))
    const room = (node.v1 - node.v0) / 2 - 12
    const step = isVertical ? 16 : LANE
    return (node.v0 + node.v1) / 2 + spread(sorted.length, sorted.indexOf(r), step, room)
  }

  const lanes = new Map<string, Route[]>()
  for (const r of routes) lanes.set(r.gap, [...(lanes.get(r.gap) ?? []), r])

  const arrows: string[] = []
  const labels: string[] = []
  type Rect = { x: number; y: number; w: number; h: number }
  const taken: Rect[] = [...placed.values()].map(n => {
    const [x, y] = toXY([n.u0, n.v0])
    return { x, y, w: isVertical ? n.v1 - n.v0 : n.u1 - n.u0, h: NODE_H }
  })
  const overlaps = (a: Rect) => taken.some(b => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
  for (const r of routes) {
    const group = lanes.get(r.gap) ?? [r]
    const i = group.indexOf(r)
    const isLoop = r.gap.startsWith('loop')
    const laneGap = r.s.tier < r.d.tier ? gapBefore(r.d.tier) : gapAfter(r.d.tier)
    const mid = isLoop ? r.mid + i * LANE : r.mid + spread(group.length, i, LANE, laneLimit(laneGap))
    const su = r.sEnd ? r.s.u1 : r.s.u0
    const du = r.dEnd ? r.d.u1 : r.d.u0
    const sv = portV(r, 's')
    const dv = portV(r, 'd')

    // An edge that skips a tier would run behind the boxes in between: lift it
    // into the free corridor nearest its source instead.
    const between = [...placed.values()].filter(
      n => n.tier > Math.min(r.s.tier, r.d.tier) && n.tier < Math.max(r.s.tier, r.d.tier),
    )
    const isBlocked = (w: number) => between.some(n => w >= n.v0 - 4 && w <= n.v1 + 4)
    let points: Point[]
    let labelAt: Point
    if (between.length && (isBlocked(sv) || isBlocked(dv))) {
      const corridors = [-PAD / 2, acrossLen + PAD / 2, ...[...placed.values()].map(n => n.v1 + gap.across / 2)]
        .filter(w => !isBlocked(w))
        .sort((a, b) => Math.abs(a - sv) - Math.abs(b - sv))
      const cv = corridors[0] ?? -PAD / 2
      const exitGap = r.sEnd ? gapAfter(r.s.tier) : gapBefore(r.s.tier)
      const exit = r.sEnd ? r.s.u1 + exitGap / 2 : r.s.u0 - exitGap / 2
      const m1 = exit + spread(group.length, i, LANE, laneLimit(exitGap))
      points = [[su, sv], [m1, sv], [m1, cv], [mid, cv], [mid, dv], [du, dv]]
      labelAt = [(su + m1) / 2, sv]
    } else if (Math.abs(sv - dv) < 1 && !isLoop) {
      points = [[su, sv], [du, dv]]
      labelAt = [(su + du) / 2, sv]
    } else {
      points = [[su, sv], [mid, sv], [mid, dv], [du, dv]]
      labelAt = [mid, (sv + dv) / 2]
    }

    const style = r.edge.style ?? 'call'
    const color = style === 'http' ? 'link' : 'muted'
    const dash = style === 'async' ? ' stroke-dasharray="4,3"' : ''
    const weight = style === 'async' ? 1 : 1.2
    arrows.push(
      `<path d="${ortho(points.map(toXY))}" fill="none" style="stroke:${v(color)}" stroke-width="${weight}"${dash} marker-end="url(#arrow-${color})"/>`,
    )
    if (r.edge.label) {
      const text = clip(r.edge.label.toUpperCase(), 18)
      const w = grid(text.length * TYPE.label * 0.68 + 8)
      const [cx, cy] = toXY(labelAt)
      const box = { x: cx - w / 2, y: cy - 7, w, h: 14 }
      // A label that would sit on a box or another label is left out; the
      // full-size view has the room to show it.
      if (overlaps(box) || box.x < 0 || box.x + w > width) continue
      taken.push(box)
      labels.push(
        `<rect x="${cx - w / 2}" y="${cy - 7}" width="${w}" height="14" rx="2" style="fill:${v('paper')}"/>`,
        `<text x="${cx}" y="${cy + 3}" text-anchor="middle" font-family="${esc(f.mono)}" font-size="${TYPE.label}" letter-spacing="0.06em" style="fill:${v('muted')}">${esc(text)}</text>`,
      )
    }
  }

  const boxes = [...placed.values()].map(n => {
    const [x, y] = toXY([n.u0, n.v0])
    const w = isVertical ? n.v1 - n.v0 : n.u1 - n.u0
    const s = shape(n, focus.has(n.id))
    const tip = n.path ? `${n.label} — ${n.path}${n.line ? `:${n.line}` : ''}` : n.label
    const nameY = n.sublabel ? y + 38 : y + 42
    return [
      `<g${overlay.ids ? ` data-id="${esc(n.id)}" style="cursor:pointer"` : ''}><title>${esc(tip)}</title>`,
      `<rect x="${x}" y="${y}" width="${w}" height="${NODE_H}" rx="6" style="fill:${v(s.fill)};stroke:${v(s.stroke)}" stroke-width="1"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`,
      `<text x="${x + 14}" y="${y + 18}" font-family="${esc(f.mono)}" font-size="${TYPE.eyebrow}" font-weight="500" letter-spacing="0.18em" style="fill:${v(focus.has(n.id) ? 'accent' : 'soft')}">${n.kind.toUpperCase()}</text>`,
      `<text x="${x + 14}" y="${nameY}" font-family="${esc(f.sans)}" font-size="${TYPE.name}" font-weight="600" style="fill:${v('ink')}">${esc(clip(n.label, Math.floor((w - 28) / ADVANCE.name)))}</text>`,
      n.sublabel
        ? `<text x="${x + 14}" y="${y + 54}" font-family="${esc(f.mono)}" font-size="${TYPE.sub}" style="fill:${v('muted')}">${esc(clip(n.sublabel, Math.floor((w - 28) / ADVANCE.sub)))}</text>`
        : '',
      '</g>',
    ].join('')
  })

  const active = new Set(overlay.active ?? [])
  const marks = Object.entries(overlay.marks ?? {})
  const overlays = [...placed.values()].flatMap(n => {
    const [x, y] = toXY([n.u0, n.v0])
    const w = isVertical ? n.v1 - n.v0 : n.u1 - n.u0
    const out: string[] = []
    if (active.has(n.id)) {
      out.push(
        `<circle cx="${x + w - 10}" cy="${y + 10}" r="4" style="fill:${v('accent')}"><animate attributeName="opacity" values="1;0.25;1" dur="1.4s" repeatCount="indefinite"/></circle>`,
      )
    }
    const mark = marks.find(([id]) => id === n.id)
    if (mark) {
      out.push(`<path d="${sketchLoop(n.id, x, y, w, NODE_H)}" fill="none" style="stroke:${v('accent')}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`)
      if (mark[1]) {
        const text = clip(mark[1], 34)
        // Beside the box when there is room, else under it.
        const fits = x + w + 18 + text.length * 6.6 < width - 8
        const [tx, ty] = fits ? [x + w + 18, y - 6] : [x, y + NODE_H + 26]
        out.push(
          `<text x="${tx}" y="${ty}" font-family="${esc(f.sans)}" font-size="11" font-style="italic" style="fill:${v('accent')}">${esc(text)}</text>`,
        )
      }
    }
    return out
  })

  const tierLabels = tiers.filter(t => t.isFirst).map(t => {
    const [x, y] = isVertical ? [bx, by + t.u0 - 12] : toXY([t.u0, -12])
    const w = grid(t.label.length * TYPE.eyebrow * 0.8 + 8)
    return [
      `<rect x="${x - 4}" y="${y - 9}" width="${w}" height="12" style="fill:${v('paper')}"/>`,
      `<text x="${x}" y="${y}" font-family="${esc(f.mono)}" font-size="${TYPE.eyebrow}" letter-spacing="0.14em" style="fill:${v('tierInk')}">${t.label}</text>`,
    ].join('')
  })

  const title = esc(graph?.title ?? 'System architecture')
  const meta = nodes.length
    ? `${nodes.length} COMPONENTS · ${edges.length} CONNECTIONS`
    : 'NO COMPONENTS YET — MAP THE REPO OR START BUILDING'

  const vars = (r: Roles) => Object.entries(r).map(([k, val]) => `--${k}:${val}`).join(';')
  // A page holding the SVG can force a mode with data-theme on any ancestor
  // (the notepad's light/dark toggle); on its own, the SVG follows its mode.
  const light = vars(roles(theme.light))
  const dark = vars(roles(theme.dark))
  const forced = `[data-theme="light"] svg{${light}}[data-theme="dark"] svg{${dark}}`
  const css =
    theme.mode === 'auto'
      ? `svg{${light}}@media (prefers-color-scheme: dark){svg{${dark}}}${forced}`
      : `svg{${vars(base)}}${forced}`

  const marker = (color: string) =>
    `<marker id="arrow-${color}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" style="fill:${v(color)}"/></marker>`

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<style>${css}</style>`,
    `<defs>${marker('muted')}${marker('link')}</defs>`,
    `<rect width="${width}" height="${height}" style="fill:${v('paper')}"/>`,
    `<text x="${MARGIN}" y="${MARGIN + 24}" font-family="${esc(f.serif)}" font-size="${TYPE.title}" style="fill:${v('ink')}">${title}</text>`,
    `<text x="${MARGIN}" y="${MARGIN + 44}" font-family="${esc(f.mono)}" font-size="${TYPE.meta}" letter-spacing="0.14em" style="fill:${v('soft')}">${meta}</text>`,
    ...arrows,
    ...labels,
    ...tierLabels,
    ...boxes,
    ...overlays,
    '</svg>',
  ].join('')

  const alt = nodes.length
    ? `${graph?.title ?? 'System architecture'}: ${nodes.map(n => `${n.label} (${n.kind})`).join(', ')}.`
    : 'An empty architecture diagram.'

  return { svg, alt, width, height, orientation }
}

// Draws the graph; given the room it has in CSS pixels, picks the direction
// that shows it largest (a narrow side pane gets top-to-bottom).
// Draws the graph left to right; given the pane's width in CSS pixels, top to
// bottom instead, wrapping each tier onto as few rows as still fit that width.
export const renderSvg = (graph: ArchGraph | null, theme: ArchTheme, roomPx?: number, overlay: Overlay = {}): Drawing => {
  if (!roomPx) return layout(graph, theme, 'horizontal', 0, overlay)
  const widest = Math.max(
    1,
    ...TIERS.map(t => (graph?.nodes ?? []).filter(n => t.kinds.includes(n.kind)).length),
  )
  let best: Drawing | undefined
  for (let per = widest; per >= 1; per--) {
    const drawing = layout(graph, theme, 'vertical', per, overlay)
    if (drawing.width <= roomPx / 0.9) return drawing
    if (!best || drawing.width < best.width) best = drawing
  }
  return best ?? layout(graph, theme, 'vertical', 1, overlay)
}

// A full-page view of the drawing that reloads itself, for a browser window.
export const popoutHtml = (drawing: Drawing, theme: ArchTheme): string =>
  [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta http-equiv="refresh" content="3">',
    '<title>Architecture · arch-live</title>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">',
    `<style>html,body{margin:0;background:${theme.light.paper}}@media (prefers-color-scheme: dark){html,body{background:${theme.dark.paper}}}`,
    'body{display:flex;justify-content:center;padding:24px}svg{max-width:100%;height:auto}</style>',
    `</head><body>${drawing.svg}</body></html>`,
  ].join('')

// What a surface without SVG draws: the same graph as text.
export const outline = (graph: ArchGraph | null): string => {
  if (!graph || graph.nodes.length === 0) return '_No components yet._'
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const lines = [`**${graph.title ?? 'System architecture'}**`, '']
  for (const tier of TIERS) {
    const members = graph.nodes.filter(n => tier.kinds.includes(n.kind))
    if (members.length === 0) continue
    lines.push(`- **${tier.label}** ${members.map(n => (graph.focus.includes(n.id) ? `*${n.label}*` : n.label)).join(' · ')}`)
  }
  if (graph.edges.length) {
    lines.push('')
    for (const e of graph.edges) {
      const label = e.label ? ` (${e.label})` : ''
      lines.push(`- ${byId.get(e.from)?.label ?? e.from} → ${byId.get(e.to)?.label ?? e.to}${label}`)
    }
  }
  return lines.join('\n')
}
