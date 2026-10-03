import type { ArchPalette, ArchTheme } from '../types'

// The diagram-design default skin (references/style-guide.md), mapped to the
// roles an architecture diagram needs.
export const DEFAULT_THEME: ArchTheme = {
  name: 'Editorial (default)',
  mode: 'auto',
  light: {
    paper: '#f5f5f5',
    paper2: '#ececec',
    ink: '#2d3142',
    muted: '#4f5d75',
    soft: '#7a8399',
    rule: 'rgba(45,49,66,0.12)',
    accent: '#eb6c36',
    accentTint: 'rgba(235,108,54,0.08)',
    link: '#2e5aa8',
    nodeFill: '#ffffff',
  },
  dark: {
    paper: '#2d3142',
    paper2: '#393e53',
    ink: '#f5f5f5',
    muted: '#bfc0c0',
    soft: '#8e98ac',
    rule: 'rgba(245,245,245,0.12)',
    accent: '#f08a59',
    accentTint: 'rgba(240,138,89,0.10)',
    link: '#6a95d8',
    nodeFill: '#393e53',
  },
  fonts: {
    serif: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace",
    sans: "'JetBrains Mono', 'Geist', ui-monospace, monospace",
    mono: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace",
  },
}

const ROLES = Object.keys(DEFAULT_THEME.light) as (keyof ArchPalette)[]
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i

type Rgb = [number, number, number]

const parse = (color: string): Rgb | undefined => {
  const match = /^#(?:([0-9a-f]{6})(?:[0-9a-f]{2})?|([0-9a-f]{3}))$/i.exec(color.trim())
  const hex = match?.[1] ?? match?.[2]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as Rgb
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color)
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined
}

export const alpha = (color: string, a: number): string => {
  const rgb = parse(color)
  return rgb ? `rgba(${rgb.join(',')},${a})` : color
}

const mix = (a: string, b: string, t: number): string => {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return a
  const hex = x.map((v, i) => Math.round(v + ((y[i] ?? v) - v) * t).toString(16).padStart(2, '0'))
  return `#${hex.join('')}`
}

// The style guide's inversion rule: paper and ink swap, the rest follows.
const deriveDark = (l: ArchPalette): ArchPalette => ({
  paper: l.ink,
  paper2: mix(l.ink, l.paper, 0.1),
  ink: l.paper,
  muted: mix(l.paper, l.ink, 0.3),
  soft: mix(l.paper, l.ink, 0.45),
  rule: alpha(l.paper, 0.12),
  accent: mix(l.accent, '#ffffff', 0.15),
  accentTint: alpha(l.accent, 0.12),
  link: mix(l.link, '#ffffff', 0.35),
  nodeFill: mix(l.ink, l.paper, 0.1),
})

const palette = (input: unknown, base: ArchPalette): ArchPalette => {
  const given = (input ?? {}) as Record<string, unknown>
  const out = { ...base }
  for (const role of ROLES) {
    const value = given[role]
    if (typeof value === 'string' && COLOR.test(value.trim())) out[role] = value.trim()
  }
  return out
}

const font = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.replace(/[<>"&;{}]/g, '').slice(0, 200) : fallback

export const normalizeTheme = (input: unknown): ArchTheme => {
  const t = (input ?? {}) as Record<string, unknown>
  const light = palette(t.light, DEFAULT_THEME.light)
  const fonts = (t.fonts ?? {}) as Record<string, unknown>
  return {
    name: typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 80) : 'Custom',
    source: typeof t.source === 'string' ? t.source.slice(0, 300) : undefined,
    mode: t.mode === 'light' || t.mode === 'dark' ? t.mode : 'auto',
    light,
    dark: palette(t.dark, t.dark ? DEFAULT_THEME.dark : deriveDark(light)),
    fonts: {
      serif: font(fonts.serif, DEFAULT_THEME.fonts.serif),
      sans: font(fonts.sans, DEFAULT_THEME.fonts.sans),
      mono: font(fonts.mono, DEFAULT_THEME.fonts.mono),
    },
  }
}

const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string): number | undefined => {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return undefined
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// The style guide's constraints, checked so the model can correct a palette.
export const themeWarnings = (theme: ArchTheme): string[] => {
  const out: string[] = []
  for (const mode of ['light', 'dark'] as const) {
    const p = theme[mode]
    const checks: [string, string, string, number][] = [
      ['ink', p.ink, p.paper, 4.5],
      ['muted', p.muted, p.paper, 4.5],
      ['accent', p.accent, p.paper, 2.5],
    ]
    for (const [role, fg, bg, min] of checks) {
      const ratio = contrast(fg, bg)
      if (ratio !== undefined && ratio < min) {
        out.push(`${mode}.${role} on paper is ${ratio.toFixed(2)}:1, below ${min}:1`)
      }
    }
  }
  if (theme.light.paper.toLowerCase() === '#ffffff') {
    out.push('light.paper is pure white; the style guide wants a warm-neutral paper')
  }
  return out
}
