import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The journal tools as Claude calls them, through the engine, over a disk the
// test fakes: nothing here touches the real ~/.claude/arch-live.

const HOME = '/home/test'
const PROJECT = '/work/shop'
const NOW = new Date('2026-10-04T10:00:00').getTime()

// Hooks on an engine call answer { value }, or { deny } to make the caller's
// promise reject, as a missing file or a full disk does.
const fakeDisk = (on: On, { isFull = false, cwd = PROJECT } = {}) => {
  const files = new Map<string, string>()
  mock.env(on, { HOME })
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.cwd', async () => ({ value: cwd }))
  on('session.id', async () => ({ value: 'test-session' }))
  on('fs.read', async ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', async ($, e) => {
    if (isFull) return { deny: 'ENOSPC: no space left on device' }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', async ($, e) => ({ value: files.has(e.path) }))
  // A folder's entries: the files under it, and the folders they sit in.
  on('fs.list', async ($, e) => {
    const dir = `${e.path ?? PROJECT}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of files.keys()) {
      if (!path.startsWith(dir)) continue
      const [name, ...rest] = path.slice(dir.length).split('/')
      if (name) names.set(name, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: NOW, isLink: false })) }
  })
  on('fs.stat', async ($, e) => ({ deny: `ENOENT: ${e.path}` }))
  return files
}

const dayFiles = (files: Map<string, string>) =>
  [...files.keys()].filter(p => p === `${HOME}/.claude/arch-live/logs/-work-shop/2026-10-04.json`)

describe('journal tools', () => {
  test('log_todo writes the todo into the project’s journal for today', async ($, on) => {
    const files = fakeDisk(on)
    const ran = await $.tool.call({ tool: 'mcp__arch-live__log_todo', text: 'Write the migration' })
    expect(ran.result).toBe('Added the todo to the journal.')
    const [day] = dayFiles(files)
    expect(day).toBeDefined()
    expect(files.get(day!)).toContain('"text": "Write the migration"')
    expect(files.get(day!)).toContain('"by": "claude"')
  })

  test('log_blocker with resolved closes the open blocker it names', async ($, on) => {
    const files = fakeDisk(on)
    await $.tool.call({ tool: 'mcp__arch-live__log_blocker', text: 'No staging access' })
    const ran = await $.tool.call({ tool: 'mcp__arch-live__log_blocker', text: 'staging', resolved: true })
    expect(ran.result).toBe('Marked resolved: No staging access')
    expect(files.get(dayFiles(files)[0]!)).toContain('"type": "done"')
  })

  test('on a full disk the tool still answers, saying what went wrong', async ($, on) => {
    fakeDisk(on, { isFull: true })
    const ran = await $.tool.call({ tool: 'mcp__arch-live__log_blocker', text: 'Disk is full' })
    expect(String(ran.result)).toStartWith('arch-live could not log the blocker: ')
    expect(String(ran.result)).toContain('ENOSPC')
  })
})

// A session pointed at a subfolder (test/) still works on the project: the
// map up in the project root, and the project's own journal.
describe('a session in a subfolder', () => {
  const MAP = `${PROJECT}/.claude/architecture.json`
  const seed = (files: Map<string, string>) =>
    files.set(MAP, JSON.stringify({ version: 1, title: 'Shop', nodes: [{ id: 'api', label: 'API', kind: 'service' }], edges: [] }))

  test('arch_update with the subfolder as root updates the project’s map', async ($, on) => {
    const files = fakeDisk(on, { cwd: `${PROJECT}/test` })
    on('ui.open', async () => ({ value: undefined }))
    seed(files)
    const ran = await $.tool.call({ tool: 'mcp__arch-live__arch_update', root: 'test', nodes: [{ id: 'web', label: 'Web', kind: 'client' }] })
    expect(String(ran.result)).toContain(`saved to ${MAP}`)
    expect(files.has(`${PROJECT}/test/.claude/architecture.json`)).toBe(false)
    expect(files.get(MAP)).toContain('"id": "web"')
    expect(files.get(MAP)).toContain('"id": "api"')
  })

  test('log_todo goes to the project’s journal, not the subfolder’s', async ($, on) => {
    const files = fakeDisk(on, { cwd: `${PROJECT}/test` })
    seed(files)
    await $.tool.call({ tool: 'mcp__arch-live__log_todo', text: 'Cover the edge case' })
    expect(dayFiles(files)).toHaveLength(1)
    expect([...files.keys()].some(p => p.includes('/logs/-work-shop-test/'))).toBe(false)
  })
})
