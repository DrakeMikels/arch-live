// arch-live for Cursor: what the Claude Code mod does through its engine, done
// with Node and plain files, for the MCP server and the hook scripts. The map
// (<project>/.claude/architecture.json) and the journal
// (~/.claude/arch-live/logs/<project>/) are where the mod keeps them, so
// Claude Code and Cursor share one map, one journal and one notepad per project.
//
// Import ../../notepad/ts-register.mjs before this file (it lets Node find the
// mod's TypeScript modules); the entry scripts do.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DAY_MS, EXPORT_FILE, GRAPH_FILE } from '../../hooks/constants.ts'
import { marksOf, normalizeGraph } from '../../hooks/graph.ts'
import { dateKey, emptyDay, newId, openItems, parseWebLines, projectKey, resolveDays, resolveTag, snapshotOf } from '../../hooks/journal.ts'
import { projectRootOf } from '../../hooks/project-root.ts'
import { renderSvg } from '../../hooks/render.ts'
import { DEFAULT_THEME, normalizeTheme } from '../../hooks/theme.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(here, '..', '..')
export const HOME = os.homedir()
export const BASE = path.join(HOME, '.claude', 'arch-live')
export const THEME_FILE = path.join(BASE, 'theme.json')
// The workspace the person last prompted in: the MCP server's project when a
// tool call names none (Cursor starts MCP servers outside the workspace).
const ACTIVE_FILE = path.join(BASE, 'cursor-active.json')

/* ---------- Files ---------- */

export const readText = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
export const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
// Written whole, then moved into place, so a reader never sees half a file.
export const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(tmp, file)
}
const writeText = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

// The hooks run as separate processes, and the MCP server beside them: a
// journal write takes a lock (a folder, which only one can create) first.
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
export const withLock = (dir, work) => {
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, '.lock')
  const until = Date.now() + 3000
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch {
      // A lock older than 10 s was left by a process that died.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { recursive: true, force: true })
      } catch {}
      if (Date.now() > until) break
      sleep(25)
    }
  }
  try {
    return work()
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

/* ---------- The project, its map and its journal ---------- */

const exists = async p => fs.existsSync(p)
export const projectOf = async folder => projectRootOf(path.resolve(folder), exists, HOME)
export const logsDirOf = root => path.join(BASE, 'logs', projectKey(root))

export const readGraph = root => normalizeGraph(readJson(path.join(root, GRAPH_FILE), undefined) ?? undefined)
export const writeGraph = (root, graph) => writeJson(path.join(root, GRAPH_FILE), graph)
export const readTheme = () => {
  const raw = readJson(THEME_FILE, null)
  return raw ? normalizeTheme(raw) : DEFAULT_THEME
}

// Also which chat it was, so notes the agent logs land in that chat's session.
export const rememberActive = (root, session) => writeJson(ACTIVE_FILE, { root, session, at: Date.now() })
// The MCP server's project: one with a map or a git root at its own folder,
// else where the person last prompted, else its folder.
export const defaultRoot = async () => {
  const own = await projectOf(process.cwd())
  if (own !== HOME && (fs.existsSync(path.join(own, GRAPH_FILE)) || fs.existsSync(path.join(own, '.git')))) return own
  const active = readJson(ACTIVE_FILE, null)?.root
  return active && fs.existsSync(active) ? active : own
}

/* ---------- The journal on disk ---------- */

const dayFile = (logs, date) => path.join(logs, `${date}.json`)
const readRawDay = (logs, date, root) => {
  const raw = readJson(dayFile(logs, date), null)
  return raw && Array.isArray(raw.entries) ? raw : emptyDay(date, root)
}

export const changeDay = (logs, date, root, change) =>
  withLock(logs, () => {
    const day = change(readRawDay(logs, date, root))
    writeJson(dayFile(logs, date), day)
    return day
  })

export const appendEntry = (logs, root, entry) => changeDay(logs, dateKey(entry.ts), root, d => ({ ...d, entries: [...d.entries, entry] }))

// Keeps the day's opening map (as it stood before the first change) and its latest.
export const saveSnapshot = (logs, root, graph, before) => {
  const now = Date.now()
  return changeDay(logs, dateKey(now), root, day => ({
    ...day,
    opening: day.opening ?? snapshotOf(before ?? graph, now - 1),
    snapshot: snapshotOf(graph, now),
  }))
}

// The journal's days from `fromDate` on, the mod's files and the notepad's lines merged.
export const loadDays = (logs, root, fromDate) => {
  let names = []
  try {
    names = fs.readdirSync(logs)
  } catch {
    return []
  }
  const dates = [...new Set(names.map(n => /^(\d{4}-\d{2}-\d{2})\.(?:json|web\.jsonl)$/.exec(n)?.[1]).filter(d => d && d >= fromDate))].sort()
  const days = dates.map(date => {
    const day = readRawDay(logs, date, root)
    return { ...day, entries: [...day.entries, ...parseWebLines(readText(path.join(logs, `${date}.web.jsonl`)))] }
  })
  return resolveDays(days, { tracksCommits: readJson(path.join(logs, 'git.json'), {}).repo === true })
}
export const recentDays = (logs, root) => loadDays(logs, root, dateKey(Date.now() - 60 * DAY_MS))

// A note in the journal, tagged with a component when it names one (@id).
export const addNote = (logs, root, type, raw, by, extra = {}) => {
  const tagged = resolveTag(readGraph(root), raw)
  let text = tagged.text
  let why = extra.why
  if (type === 'decision' && !why) {
    const parts = /^(.*?)\s+because\s+(.*)$/i.exec(text)
    if (parts) [text, why] = [parts[1] ?? text, parts[2]]
  }
  const now = Date.now()
  const note = JSON.parse(JSON.stringify({
    id: newId(now),
    ts: now,
    type,
    text,
    by,
    component: extra.component ?? tagged.component,
    ...(why ? { why } : {}),
    ...(extra.alternatives ? { alternatives: extra.alternatives } : {}),
    ...(extra.session ? { session: extra.session } : {}),
  }))
  appendEntry(logs, root, note)
  return note
}

// Marks the open todo or blocker best matching `query` as done.
export const closeItem = (logs, root, types, query, by) => {
  const q = query.trim().toLowerCase()
  const hit = [...openItems(recentDays(logs, root))].reverse().find(n => types.includes(n.type) && (n.id === query.trim() || n.text.toLowerCase().includes(q)))
  if (!hit) return undefined
  const now = Date.now()
  appendEntry(logs, root, { id: newId(now), ts: now, type: 'done', ref: hit.id, by })
  return hit
}

/* ---------- Sessions ---------- */

// One small file per Cursor chat (its conversation id), as the mod keeps one
// per Claude Code session; the notepad lists and renames them.
export const changeSession = (logs, id, change) => {
  if (!id) return
  const file = path.join(logs, 'sessions', `${String(id).replace(/[^\w-]/g, '')}.json`)
  const now = Date.now()
  const prev = readJson(file, null)
  const base = prev?.id ? prev : { id, startedAt: now, lastAt: now, app: 'cursor' }
  writeJson(file, change({ ...base, lastAt: now }))
}

/* ---------- Standups ---------- */

export const lastStandup = logs => Number(readJson(path.join(logs, 'standup.json'), {}).last ?? 0)
export const standupSince = (logs, now) => (lastStandup(logs) > now - 14 * DAY_MS ? lastStandup(logs) : now - DAY_MS)
export const saveDraft = (logs, draft) => {
  const file = path.join(logs, 'standup-drafts.json')
  const kept = readJson(file, {}).drafts ?? []
  writeJson(file, { drafts: [...kept, draft].slice(-20) })
}
export const sessionNames = logs => {
  const dir = path.join(logs, 'sessions')
  const names = {}
  try {
    for (const n of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const one = readJson(path.join(dir, n), null)
      if (one?.id && one.name) names[one.id] = one.name
    }
  } catch {}
  return names
}

/* ---------- What the notepad reads ---------- */

// The drawn map and the project's facts, as the mod writes them: live.svg and meta.json.
export const publishLive = (root, logs, active = []) => {
  const graph = readGraph(root)
  const theme = readTheme()
  const overlay = { marks: marksOf(recentDays(logs, root)), active, ids: true }
  writeText(path.join(logs, 'live.svg'), renderSvg(graph, theme, undefined, overlay).svg)
  writeJson(path.join(logs, 'meta.json'), {
    project: root,
    title: graph?.title ?? path.basename(root),
    nodes: (graph?.nodes ?? []).map(n => ({ id: n.id, label: n.label, kind: n.kind, path: n.path ?? null, line: n.line ?? null })),
    theme: { light: theme.light, dark: theme.dark, fonts: theme.fonts, mode: theme.mode, name: theme.name ?? null, source: theme.source ?? null },
    marks: overlay.marks ?? {},
    active,
    updatedAt: Date.now(),
    app: 'cursor',
  })
}

export const exportSvg = root => {
  const graph = readGraph(root)
  if (!graph) return 'Nothing to export yet: map the project first (/arch-map).'
  const file = path.join(root, EXPORT_FILE)
  writeText(file, `${renderSvg(graph, readTheme()).svg}\n`)
  return `Wrote ${file}. Embed it with ![Architecture](${EXPORT_FILE}).`
}

/* ---------- The browser notepad ---------- */

// The project's notepad if one answers (any app's), else one started here, in
// the background, for Cursor: notepad requests come back as Cursor prompts.
export const liveNotepad = async logs => {
  const info = readJson(path.join(logs, 'notepad.json'), null)
  if (!info?.token || !info.port) return undefined
  const url = `http://127.0.0.1:${info.port}`
  try {
    const res = await fetch(`${url}/api/ping?t=${info.token}`, { signal: AbortSignal.timeout(1200) })
    return res.ok ? `${url}/?t=${info.token}` : undefined
  } catch {
    return undefined
  }
}

// `wait: false` starts it and returns at once (a hook must not hold the agent up).
export const ensureNotepad = async (root, logs, session, { wait = true } = {}) => {
  const live = await liveNotepad(logs)
  if (live) return live
  publishLive(root, logs)
  // With this process's flags: an older Node needs --experimental-strip-types too.
  const args = [...process.execArgv, path.join(REPO, 'notepad', 'server.mjs'), '--logs', logs, '--project', root, '--host', 'cursor', ...(session ? ['--session', session] : [])]
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: root })
  child.unref()
  if (!wait) return undefined
  // It writes notepad.json once it listens.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 100))
    const up = await liveNotepad(logs)
    if (up) return up
  }
  return undefined
}
