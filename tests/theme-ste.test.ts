import { describe, expect, test } from 'claude-code/testing'

import { distill, LIMITS } from '../hooks/ste'
import { alpha, DEFAULT_THEME, normalizeTheme, themeWarnings } from '../hooks/theme'

describe('theme', () => {
  test('alpha turns a hex or rgb color into rgba, and leaves others alone', () => {
    expect(alpha('#ff0000', 0.5)).toBe('rgba(255,0,0,0.5)')
    expect(alpha('rgb(1, 2, 3)', 0.2)).toBe('rgba(1,2,3,0.2)')
    expect(alpha('tomato', 0.2)).toBe('tomato')
  })

  test('the default theme passes its own checks', () => {
    expect(themeWarnings(DEFAULT_THEME)).toEqual([])
  })

  test('normalizing keeps good colors, drops bad ones, and derives a dark palette', () => {
    const t = normalizeTheme({ name: '  Acme  ', light: { paper: '#fafaf7', ink: '#111111', accent: 'not a color' }, mode: 'sepia' })
    expect(t.name).toBe('Acme')
    expect(t.mode).toBe('auto')
    expect(t.light.paper).toBe('#fafaf7')
    expect(t.light.accent).toBe(DEFAULT_THEME.light.accent)
    expect(t.dark.paper).toBe('#111111')
    expect(t.dark.ink).toBe('#fafaf7')
  })

  test('fonts are cleaned of anything that could break out of CSS', () => {
    const t = normalizeTheme({ fonts: { sans: 'Inter"; } body { color: red' } })
    expect(t.fonts.sans).not.toContain('"')
    expect(t.fonts.sans).not.toContain('}')
    expect(t.fonts.mono).toBe(DEFAULT_THEME.fonts.mono)
  })

  test('warns on low contrast and on pure white paper', () => {
    const t = normalizeTheme({ light: { paper: '#ffffff', ink: '#eeeeee' }, dark: DEFAULT_THEME.dark })
    const warnings = themeWarnings(t)
    expect(warnings.some(w => w.startsWith('light.ink on paper'))).toBe(true)
    expect(warnings).toContain('light.paper is pure white; the style guide wants a warm-neutral paper')
  })
})

describe('distill (STE English)', () => {
  test('plain words replace wordy ones, and contractions open up', () => {
    const [s] = distill("We can't utilize the cache in order to speed it up.").statements
    expect(s!.text).toBe('We cannot use the cache to speed it up.')
  })

  test('a request loses its "can you please"', () => {
    const [s] = distill('Can you please add a retry to the orders client?', { mode: 'request' }).statements
    expect(s!.text).toBe('Add a retry to the orders client.')
    expect(s!.kind).toBe('step')
  })

  test('a log speaks of Claude, drops questions and sign-offs', () => {
    const out = distill('I fixed the flaky test in `orders.spec.ts`. Want me to push it?', { mode: 'log' })
    expect(out.statements.map(s => s.text)).toEqual(['Fixed the flaky test in `orders.spec.ts`.'])
  })

  test('code and paths are kept exactly', () => {
    const [s] = distill('Run `npm run build:prod` in apps/web/src first.').statements
    expect(s!.text).toContain('`npm run build:prod`')
    expect(s!.text).toContain('apps/web/src')
  })

  test('long sentences are split near the limit; max caps the count and says how many more', () => {
    const long = 'The worker reads the queue every second and it writes each order to the database, which then sends an email to the customer and updates the dashboard for the team.'
    const out = distill(long)
    for (const s of out.statements) expect(s.text.split(/\s+/).length).toBeLessThanOrEqual(LIMITS.desc + 2)
    const capped = distill('One thing here. Two things here. Three things here.', { max: 2 })
    expect(capped.statements).toHaveLength(2)
    expect(capped.more).toBe(1)
  })

  test('repeated sentences are said once; nothing in, nothing out', () => {
    expect(distill('Fixed the bug. Fixed the bug.').statements).toHaveLength(1)
    expect(distill('').statements).toEqual([])
    expect(distill('').score).toBeNull()
  })
})
