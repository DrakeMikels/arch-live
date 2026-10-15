import { describe, expect, test } from 'claude-code/testing'

import type { JournalDay, JournalEntry, JournalSession } from '../types'
import { folderProject, mergeDay, mergeSession, mergeWebLines } from '../hooks/journal'

const ROOT = '/Users/me/Dev Projects/app'
const turn = (id: string, ts: number): JournalEntry => ({ id, ts, type: 'turn', request: id, summary: [], files: [], components: [] })
const day = (project: string, entries: JournalEntry[], extra: Partial<JournalDay> = {}): JournalDay => ({ version: 1, date: '2026-10-15', project, entries, ...extra })

describe('folderProject', () => {
  test('picks the path the folder is named after', () => {
    const key = '-Users-me-Dev-Projects-app-test'
    expect(folderProject(key, [undefined, `${ROOT}/other`, `${ROOT}/test`])).toBe(`${ROOT}/test`)
    expect(folderProject(key, [ROOT, 'relative/test'])).toBeUndefined()
  })
})

describe('mergeDay', () => {
  test('adds the source entries in time order, under the root project', () => {
    const target = day(ROOT, [turn('a', 1), turn('c', 3)], { snapshot: { ts: 5, nodes: [], edges: [] } })
    const merged = mergeDay(target, day(`${ROOT}/test`, [turn('b', 2), turn('d', 4)]), ROOT)
    expect(merged.entries.map(e => e.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.project).toBe(ROOT)
    expect(merged.snapshot?.ts).toBe(5)
  })

  test('is idempotent: merging twice adds nothing', () => {
    const source = day(`${ROOT}/test`, [turn('b', 2)])
    const once = mergeDay(day(ROOT, [turn('a', 1)]), source, ROOT)
    expect(mergeDay(once, source, ROOT)).toEqual(once)
  })

  test('a day only the source has becomes the root project’s day', () => {
    const merged = mergeDay(undefined, day(`${ROOT}/test`, [turn('b', 2)], { opening: { ts: 1, nodes: [], edges: [] } }), ROOT)
    expect(merged.project).toBe(ROOT)
    expect(merged.entries).toHaveLength(1)
    expect(merged.opening?.ts).toBe(1)
  })

  test('keeps the earlier opening map and the later latest map', () => {
    const snap = (ts: number) => ({ ts, nodes: [], edges: [] })
    const merged = mergeDay(day(ROOT, [], { opening: snap(5), snapshot: snap(6) }), day(ROOT, [], { opening: snap(2), snapshot: snap(9) }), ROOT)
    expect([merged.opening?.ts, merged.snapshot?.ts]).toEqual([2, 9])
  })
})

describe('mergeWebLines', () => {
  const line = (id: string, ts: number) => JSON.stringify({ id, ts, type: 'note', text: id, by: 'you' })
  test('appends the lines the target lacks, once', () => {
    const target = `${line('a', 1)}\n`
    const source = `${line('a', 1)}\n${line('b', 2)}\n`
    const merged = mergeWebLines(target, source)
    expect(merged).toBe(`${line('a', 1)}\n${line('b', 2)}\n`)
    expect(mergeWebLines(merged, source)).toBe(merged)
  })
})

describe('mergeSession', () => {
  const s = (over: Partial<JournalSession>): JournalSession => ({ id: 's1', startedAt: 10, lastAt: 20, ...over })
  test('keeps the target’s record over the span of both', () => {
    const merged = mergeSession(s({ name: 'root name' }), s({ startedAt: 5, lastAt: 30, name: 'sub name' }))
    expect(merged).toEqual({ id: 's1', startedAt: 5, lastAt: 30, name: 'root name' })
  })
  test('a name the person gave wins over a derived one', () => {
    expect(mergeSession(s({ name: 'auto' }), s({ name: 'Mine', isNamed: true })).name).toBe('Mine')
  })
  test('with no target, the source as is', () => {
    expect(mergeSession(undefined, s({}))).toEqual(s({}))
  })
})
