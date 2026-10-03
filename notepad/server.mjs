// arch-live notepad: a local, dependency-free server for the browser view of
// the work journal. One runs per project, on that project's own port; any open
// session's mod may start it (`node server.mjs --logs <dir> --project <path>
// --session <id>`), and when that session goes, another takes over on the same
// address. A page says which session it is for with `s=<id>` in its address;
// requests for Claude go to that session's inbox file, which its mod reads. It binds 127.0.0.1
// on a free port, prints `NOTEPAD <url>`, and answers only requests carrying
// the token in that url.
//
// It reads what the mod writes (<date>.json, live.svg, meta.json) and appends
// the notes typed in the browser to <date>.web.jsonl, so the two never write
// the same file.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildStandup,
  dateKey,
  dayLabel,
  labelsFrom,
  newId,
  openItems,
  parseWebLines,
  resolveDays,
  resolveTag,
} from '../hooks/journal.ts'
import { createWorkspace } from './workspace.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const LOGS = arg('logs')
const PROJECT = arg('project')
const SELF = arg('session') ?? null
if (!LOGS || !PROJECT) {
  console.error('usage: server.mjs --logs <dir> --project <path>')
  process.exit(2)
}
fs.mkdirSync(LOGS, { recursive: true })

// The same address every time for a project: a port from its logs folder and
// a token kept in it, so an open tab or a bookmark survives restarts.
const stored = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOGS, 'notepad.json'), 'utf8'))
  } catch {
    return {}
  }
})()
const TOKEN = typeof stored.token === 'string' && /^[a-f0-9]{24}$/.test(stored.token) ? stored.token : randomBytes(12).toString('hex')
let hash = 0
for (const ch of path.resolve(LOGS)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
const STABLE_PORT = 47100 + (hash % 1000)
const DAY_MS = 24 * 60 * 60 * 1000
const NOTE_TYPES = new Set(['note', 'todo', 'blocker', 'decision', 'mark'])

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const readText = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const graph = () => readJson(path.join(PROJECT, '.claude', 'architecture.json'), null)
const meta = () => readJson(path.join(LOGS, 'meta.json'), { project: PROJECT, title: path.basename(PROJECT), nodes: [] })

// Every day from `from` on, the mod's file and the browser's lines merged.
const loadDays = from => {
  const dates = [
    ...new Set(
      fs
        .readdirSync(LOGS)
        .map(name => /^(\d{4}-\d{2}-\d{2})\.(?:json|web\.jsonl)$/.exec(name)?.[1])
        .filter(d => d && d >= from),
    ),
  ].sort()
  const days = dates.map(date => {
    const day = readJson(path.join(LOGS, `${date}.json`), null) ?? { version: 1, date, project: PROJECT, entries: [] }
    const web = parseWebLines(readText(path.join(LOGS, `${date}.web.jsonl`)))
    return { ...day, entries: [...(day.entries ?? []), ...web] }
  })
  return resolveDays(days)
}

const recent = () => loadDays(dateKey(Date.now() - 60 * DAY_MS))

// The project's sessions, newest first, from sessions/<id>.json.
const SESSIONS = path.join(LOGS, 'sessions')
const sessionFile = id => path.join(SESSIONS, `${String(id).replace(/[^\w-]/g, '')}.json`)
const sessions = () => {
  let names = []
  try {
    names = fs.readdirSync(SESSIONS).filter(n => n.endsWith('.json'))
  } catch {
    return []
  }
  return names
    .map(n => readJson(path.join(SESSIONS, n), null))
    .filter(s => s?.id)
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
}
// The title the Claude app shows for a session, and the folder it runs in,
// read from its transcript (~/.claude/projects/<folder>/<id>.jsonl). The
// title sits near the end, the folder near the start; both are cached by mtime.
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const chatCache = new Map()
const transcriptOf = id => {
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, d, `${id}.jsonl`)
      if (fs.existsSync(f)) return f
    }
  } catch {}
  return null
}
const readRange = (file, start, length) => {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = fs.readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}
const unjson = raw => {
  try {
    return JSON.parse(`"${raw}"`)
  } catch {
    return raw
  }
}
const chatInfo = id => {
  if (!/^[\w-]+$/.test(String(id))) return {}
  const cached = chatCache.get(id)
  const file = cached?.file ?? transcriptOf(id)
  if (!file) return {}
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return {}
  }
  if (cached && cached.mtime === stat.mtimeMs) return cached.info
  const TAIL = 2_000_000
  let titles = [...readRange(file, Math.max(0, stat.size - TAIL), TAIL).matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)]
  if (!titles.length && stat.size > TAIL) titles = [...fs.readFileSync(file, 'utf8').matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)]
  const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readRange(file, 0, 200_000))?.[1]
  const info = { title: titles.length ? unjson(titles[titles.length - 1][1]) : undefined, cwd: cwd ? unjson(cwd) : undefined }
  chatCache.set(id, { file, mtime: stat.mtimeMs, info })
  return info
}

// Sessions with the name to show: yours if you renamed it, else the app's.
const namedSessions = () =>
  sessions().map(s => {
    const chat = chatInfo(s.id)
    return { ...s, name: s.isNamed ? s.name : (chat.title ?? s.name), folder: chat.cwd ?? null }
  })
const sessionNames = () => Object.fromEntries(namedSessions().filter(s => s.name).map(s => [s.id, s.name]))

// Tells the mod (which reads this process's output) to refresh its pane.
const changed = () => process.stdout.write('CHANGED\n')

// Hands a session's mod a request for Claude (describe a component, read a
// board, write the standup): a line in that session's inbox, which it reads.
const isId = v => typeof v === 'string' && /^[\w-]{1,80}$/.test(v)
const ask = (request, target) => {
  if (!isId(target)) return process.stdout.write(`ASK ${JSON.stringify(request)}\n`)
  fs.mkdirSync(path.join(LOGS, 'inbox'), { recursive: true })
  fs.appendFileSync(path.join(LOGS, 'inbox', `${target}.jsonl`), `${JSON.stringify(request)}\n`)
}
// The session a request is for: the page's `s`, else the one that started us.
const selfOf = url => (isId(url.searchParams.get('s')) ? url.searchParams.get('s') : SELF)

const append = entry => {
  fs.appendFileSync(path.join(LOGS, `${dateKey(entry.ts)}.web.jsonl`), `${JSON.stringify(entry)}\n`)
  changed()
}

const state = (date, self) => {
  const now = Date.now()
  const today = dateKey(now)
  const days = recent()
  const g = graph()
  const chosen = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today
  const day = days.find(d => d.date === chosen) ?? { version: 1, date: chosen, project: PROJECT, entries: [] }
  const dates = [...new Set([today, ...days.map(d => d.date)])].sort().reverse()
  return {
    meta: meta(),
    today,
    date: chosen,
    dates: dates.map(d => ({
      date: d,
      label: d === today ? 'Today' : dayLabel(Date.parse(`${d}T12:00:00`)),
      count: days.find(x => x.date === d)?.entries.length ?? 0,
    })),
    day,
    self,
    project: PROJECT,
    sessions: namedSessions(),
    sessionCounts: days.flatMap(d => d.entries).reduce((acc, e) => ({ ...acc, [e.session ?? '']: (acc[e.session ?? ''] ?? 0) + 1 }), {}),
    open: openItems(days),
    labels: Object.fromEntries(labelsFrom(days, g)),
  }
}

// Every day ever logged, newest first: entries whose text holds every word of
// the query (requests, summaries, notes, reasons, files, components, session).
const search = q => {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)
  if (!words.length) return { hits: [], total: 0 }
  const days = loadDays('0000-00-00')
  const labels = labelsFrom(days, graph())
  const names = sessionNames()
  const hits = []
  for (const day of [...days].reverse()) {
    for (const e of [...day.entries].sort((a, b) => b.ts - a.ts)) {
      if (e.type === 'done') continue
      const hay = [
        e.request, ...(e.summary ?? []), e.text, e.why, e.alternatives,
        ...(e.files ?? []).map(f => f.path),
        ...(e.components ?? []).map(c => labels.get(c) ?? c),
        e.component ? (labels.get(e.component) ?? e.component) : '',
        e.session ? names[e.session] : '',
      ].filter(Boolean).join(' ').toLowerCase()
      if (!words.every(w => hay.includes(w))) continue
      hits.push({
        date: day.date,
        id: e.id,
        ts: e.ts,
        type: e.type,
        title: e.request ?? e.text ?? '',
        detail: e.type === 'turn' ? (e.summary ?? []).join(' ') : (e.why ? `because ${e.why}` : ''),
        session: e.session ?? null,
        done: !!e.done,
      })
    }
  }
  for (const a of archived()) {
    const text = [a.written ?? '', a.brief ?? '', a.scope ?? '', ...(a.drafts ?? []).map(d => d.markdown)].join('\n')
    if (!words.every(w => text.toLowerCase().includes(w))) continue
    const line = text.split('\n').find(l => words.some(w => l.toLowerCase().includes(w))) ?? ''
    hits.push({ date: dateKey(a.at), id: a.id, ts: a.at, type: 'standup', title: `Standup · ${a.scope}`, detail: line.replace(/^[#\-*\s]+/, ''), session: null, done: false })
  }
  hits.sort((x, y) => y.ts - x.ts)
  return { hits: hits.slice(0, 150), total: hits.length }
}

const workspace = createWorkspace({ project: PROJECT, logs: LOGS, graph, recent })

// The standup window: since the last one was archived (at most two weeks),
// else the last day.
const lastGiven = () => Number(readJson(path.join(LOGS, 'standup.json'), {}).last ?? 0)
const standupSince = now => (lastGiven() > now - 14 * DAY_MS ? lastGiven() : now - DAY_MS)
const projectTitle = () => graph()?.title ?? meta().title

const standup = () => {
  const now = Date.now()
  const g = graph()
  return buildStandup({ title: projectTitle(), since: standupSince(now), now, days: recent(), graph: g, sessions: sessionNames() })
}

// Claude's write-ups since the last archive, oldest first. Each new one is
// added, never replacing the last (standup-written.json is the older single file).
const DRAFTS = path.join(LOGS, 'standup-drafts.json')
const LEGACY_DRAFT = path.join(LOGS, 'standup-written.json')
const drafts = () => {
  const list = readJson(DRAFTS, { drafts: [] }).drafts ?? []
  const legacy = readJson(LEGACY_DRAFT, null)
  const all = legacy?.markdown && !list.some(d => d.at === legacy.at) ? [...list, legacy] : list
  return all.filter(d => d?.markdown && d.at >= lastGiven()).sort((a, b) => a.at - b.at)
}

// Archived standups, one file each in standups/, newest first.
const STANDUPS = path.join(LOGS, 'standups')
const archived = () => {
  let names = []
  try {
    names = fs.readdirSync(STANDUPS).filter(n => n.endsWith('.json'))
  } catch {
    return []
  }
  return names.map(n => readJson(path.join(STANDUPS, n), null)).filter(a => a?.id).sort((a, b) => b.at - a.at)
}

// Archive & start fresh: the window's latest write-up (and earlier drafts)
// and the journal brief are saved first; only then does the window move. A
// failed save leaves everything as it was.
const archiveStandup = () => {
  const now = Date.now()
  const since = standupSince(now)
  const list = drafts()
  const latest = list[list.length - 1]
  const d = new Date(now)
  const pad = n => String(n).padStart(2, '0')
  const id = `${dateKey(now)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const record = {
    id,
    at: now,
    since,
    until: now,
    title: projectTitle(),
    scope: latest?.scope ?? 'all sessions',
    written: latest?.markdown ?? null,
    writtenAt: latest?.at ?? null,
    drafts: list.slice(0, -1).map(x => ({ markdown: x.markdown, scope: x.scope, at: x.at })),
    brief: standup(),
  }
  fs.mkdirSync(STANDUPS, { recursive: true })
  const file = path.join(STANDUPS, `${id}.json`)
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`)
  fs.renameSync(`${file}.tmp`, file)
  fs.writeFileSync(path.join(LOGS, 'standup.json'), `${JSON.stringify({ last: now }, null, 2)}\n`)
  fs.writeFileSync(DRAFTS, `${JSON.stringify({ drafts: [] }, null, 2)}\n`)
  if (fs.existsSync(LEGACY_DRAFT)) fs.unlinkSync(LEGACY_DRAFT)
  return record
}

const addNote = ({ type, text, component }, self) => {
  const kind = NOTE_TYPES.has(type) ? type : 'note'
  const tagged = resolveTag(graph(), String(text ?? '').slice(0, 2000))
  let body = tagged.text
  let why
  if (kind === 'decision') {
    const parts = /^(.*?)\s+because\s+(.*)$/i.exec(body)
    if (parts) [body, why] = [parts[1], parts[2]]
  }
  const now = Date.now()
  const entry = {
    id: newId(now),
    ts: now,
    type: kind,
    text: body || '·',
    by: 'you',
    ...(component || tagged.component ? { component: component || tagged.component } : {}),
    ...(why ? { why } : {}),
    ...(self ? { session: self } : {}),
  }
  append(entry)
  return entry
}

// Opens a component's code: VS Code's or Cursor's CLI, else the default app.
const openCode = (file, line) =>
  new Promise(resolve => {
    const abs = path.isAbsolute(file) ? file : path.join(PROJECT, file)
    const target = `${abs}:${line || 1}`
    const tries = [
      ['code', [PROJECT, '-g', target]],
      ['cursor', [PROJECT, '-g', target]],
      ['open', [abs]],
    ]
    const next = () => {
      const t = tries.shift()
      if (!t) return resolve(false)
      execFile(t[0], t[1], err => (err ? next() : resolve(true)))
    }
    next()
  })

// Live updates: any change in the logs folder or the map reaches every tab.
const clients = new Set()
let pending
const broadcast = () => {
  clearTimeout(pending)
  pending = setTimeout(() => {
    for (const res of clients) res.write(`event: change\ndata: ${Date.now()}\n\n`)
  }, 150)
}
// Recursive, so a board or session saved by another session's notepad shows too.
fs.watch(LOGS, { recursive: true }, broadcast)
const mapDir = path.join(PROJECT, '.claude')
if (fs.existsSync(mapDir)) fs.watch(mapDir, broadcast)
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 25000).unref()

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const readBody = (req, limit = 200_000) =>
  new Promise(resolve => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > limit) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'))
      } catch {
        resolve({})
      }
    })
  })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // The bundled layout library is public code, not data: no token needed.
  if (req.method === 'GET' && url.pathname === '/vendor/elk.bundled.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400' })
    return res.end(readText(path.join(here, 'vendor', 'elk.bundled.js')))
  }
  const token = url.searchParams.get('t') ?? req.headers['x-notepad-token']
  if (token !== TOKEN) return send(res, 403, { error: 'missing or wrong token' })

  const self = selfOf(url)
  try {
    if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, project: PROJECT })
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, readText(path.join(here, 'app.html')), 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': hello\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state(url.searchParams.get('date'), self))
    if (req.method === 'GET' && url.pathname === '/api/sessionlog') {
      // One session's whole history, newest day first.
      const id = url.searchParams.get('id') ?? ''
      const days = recent()
        .map(d => ({ date: d.date, entries: d.entries.filter(e => (e.session ?? '') === id) }))
        .filter(d => d.entries.length)
        .reverse()
      return send(res, 200, { id, days })
    }
    if (req.method === 'GET' && url.pathname === '/api/search') return send(res, 200, search(url.searchParams.get('q') ?? ''))
    if (req.method === 'GET' && url.pathname === '/api/standups') {
      return send(res, 200, {
        standups: archived().map(a => ({ id: a.id, at: a.at, since: a.since, until: a.until, scope: a.scope, hasWritten: !!a.written, drafts: a.drafts?.length ?? 0 })),
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/standups/one') {
      const found = archived().find(a => a.id === url.searchParams.get('id'))
      return found ? send(res, 200, found) : send(res, 404, { error: 'no such standup' })
    }
    if (req.method === 'GET' && url.pathname === '/api/standup') {
      const list = drafts()
      return send(res, 200, {
        markdown: standup(),
        written: list[list.length - 1] ?? null,
        drafts: list.slice(0, -1).reverse(),
        since: standupSince(Date.now()),
        archivedCount: archived().length,
        hasSession: !!self,
      })
    }
    if (req.method === 'GET' && url.pathname === '/live.svg') {
      return send(res, 200, readText(path.join(LOGS, 'live.svg')) || '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')
    }
    if (req.method === 'POST' && url.pathname === '/api/note') return send(res, 200, addNote(await readBody(req), self))
    if (req.method === 'GET' && url.pathname === '/api/component') {
      const found = await workspace.component(url.searchParams.get('id'))
      return found ? send(res, 200, found) : send(res, 404, { error: 'no such component' })
    }
    if (req.method === 'GET' && url.pathname === '/api/graph') {
      // Marks come from today's journal, so a new one shows at once; what
      // Claude is working in comes from the mod.
      // A mark stays on the map until it is cleared, whatever day it was made.
      const marks = {}
      for (const e of recent().flatMap(d => d.entries).sort((a, b) => a.ts - b.ts)) if (e.type === 'mark' && e.component && !e.done) marks[e.component] = e.text === '·' ? 'marked' : e.text
      const arrangement = readJson(path.join(LOGS, 'map-layout.json'), null)
      return send(res, 200, { ...(await workspace.map()), marks, active: meta().active ?? [], arrangement })
    }
    // Your own arrangement of the map: component positions, kept with the journal.
    if (req.method === 'POST' && url.pathname === '/api/arrangement') {
      const { positions } = await readBody(req)
      const clean = {}
      for (const [id, pos] of Object.entries(positions ?? {})) {
        if (isId(id) && Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) clean[id] = { x: Math.round(pos.x), y: Math.round(pos.y) }
      }
      fs.writeFileSync(path.join(LOGS, 'map-layout.json'), `${JSON.stringify({ positions: clean, updatedAt: Date.now() }, null, 2)}\n`)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/symbols') return send(res, 200, workspace.symbols(url.searchParams.get('path') ?? ''))
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readBody(req)
      // The mod builds the standup prompt itself, from the same journal.
      if (body.kind === 'standup') {
        const one = isId(body.session) ? body.session : null
        ask({ kind: 'standup', scope: one ? 'session' : 'all', ...(one ? { session: one } : {}), names: sessionNames() }, self)
        return send(res, 200, { ok: true })
      }
      if ((body.kind === 'breakdown' || body.kind === 'explain') && isId(body.component)) {
        ask({ kind: body.kind, component: body.component, ...(body.kind === 'explain' && isId(body.part) ? { part: body.part } : {}) }, self)
        return send(res, 200, { ok: true })
      }
      if (body.kind !== 'describe' || typeof body.component !== 'string') return send(res, 400, { error: 'unknown request' })
      const found = await workspace.component(body.component)
      const missing = (found?.files ?? []).filter(f => !f.summary || f.isStale).map(f => f.path).slice(0, 40)
      ask({ kind: 'describe', component: body.component, label: found?.node.label ?? body.component, files: missing }, self)
      return send(res, 200, { ok: true, files: missing.length })
    }
    if (req.method === 'POST' && url.pathname === '/api/session') {
      const { id, name } = await readBody(req)
      const prev = readJson(sessionFile(id ?? ''), null)
      if (!prev || typeof name !== 'string' || !name.trim()) return send(res, 400, { error: 'a known session and a name are required' })
      fs.writeFileSync(sessionFile(id), `${JSON.stringify({ ...prev, name: name.trim().slice(0, 60), isNamed: true }, null, 2)}\n`)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/boards') return send(res, 200, { boards: workspace.listBoards() })
    if (req.method === 'GET' && url.pathname === '/api/board') {
      return send(res, 200, readJson(workspace.boardFile(url.searchParams.get('id') ?? ''), null) ?? { error: 'no such board' })
    }
    if (req.method === 'POST' && url.pathname === '/api/board') {
      const body = await readBody(req, 8_000_000)
      if (typeof body.id !== 'string' || !Array.isArray(body.items)) return send(res, 400, { error: 'id and items are required' })
      fs.mkdirSync(workspace.boardsDir, { recursive: true })
      const prev = readJson(workspace.boardFile(body.id), null)
      const board = {
        id: body.id,
        title: String(body.title ?? 'Untitled').slice(0, 120),
        items: body.items,
        underlay: !!body.underlay,
        // The session that started the board keeps it, whoever edits it later.
        session: prev?.session ?? (isId(body.session) ? body.session : self),
        updatedAt: Date.now(),
      }
      fs.writeFileSync(workspace.boardFile(body.id), JSON.stringify(board))
      return send(res, 200, { ok: true, updatedAt: board.updatedAt })
    }
    if (req.method === 'POST' && url.pathname === '/api/board/send') {
      const body = await readBody(req, 30_000_000)
      const png = /^data:image\/png;base64,(.+)$/.exec(String(body.png ?? ''))?.[1]
      if (!png) return send(res, 400, { error: 'png is required' })
      fs.mkdirSync(workspace.boardsDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const base = path.join(workspace.boardsDir, `${String(body.id ?? 'board').replace(/[^\w-]/g, '')}-${stamp}`)
      fs.writeFileSync(`${base}.png`, Buffer.from(png, 'base64'))
      fs.writeFileSync(`${base}.md`, String(body.md ?? ''))
      const target = isId(body.target) ? body.target : self
      ask({
        kind: 'board',
        title: String(body.title ?? 'Board').slice(0, 120),
        png: `${base}.png`,
        md: String(body.md ?? '').slice(0, 60_000),
        note: String(body.note ?? '').slice(0, 4000),
        target,
        targetName: sessionNames()[target] ?? undefined,
      }, target)
      return send(res, 200, { ok: true, png: `${base}.png` })
    }
    if (req.method === 'POST' && url.pathname === '/api/done') {
      const { ref } = await readBody(req)
      if (typeof ref !== 'string') return send(res, 400, { error: 'ref is required' })
      append({ id: newId(Date.now()), ts: Date.now(), type: 'done', ref, by: 'you', ...(self ? { session: self } : {}) })
      return send(res, 200, { ok: true })
    }
    // Edits, reopening and removing are appended events, like done.
    if (req.method === 'POST' && url.pathname === '/api/undone') {
      const { ref } = await readBody(req)
      if (!isId(ref)) return send(res, 400, { error: 'ref is required' })
      append({ id: newId(Date.now()), ts: Date.now(), type: 'undone', ref, by: 'you', ...(self ? { session: self } : {}) })
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/edit') {
      const { ref, text, why } = await readBody(req)
      const body = String(text ?? '').trim().slice(0, 4000)
      if (!isId(ref) || !body) return send(res, 400, { error: 'ref and text are required' })
      append({
        id: newId(Date.now()),
        ts: Date.now(),
        type: 'edit',
        ref,
        text: body,
        ...(typeof why === 'string' ? { why: why.trim().slice(0, 2000) } : {}),
        by: 'you',
        ...(self ? { session: self } : {}),
      })
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/remove') {
      const { ref } = await readBody(req)
      if (!isId(ref)) return send(res, 400, { error: 'ref is required' })
      append({ id: newId(Date.now()), ts: Date.now(), type: 'remove', ref, by: 'you', ...(self ? { session: self } : {}) })
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/open') {
      const { path: file, line } = await readBody(req)
      if (typeof file !== 'string') return send(res, 400, { error: 'path is required' })
      return send(res, 200, { ok: await openCode(file, line) })
    }
    if (req.method === 'POST' && url.pathname === '/api/standup/given') {
      let record
      try {
        record = archiveStandup()
      } catch (err) {
        return send(res, 500, { error: `Could not archive, so nothing was reset: ${err?.message ?? err}` })
      }
      changed()
      broadcast()
      return send(res, 200, { ok: true, id: record.id })
    }
    return send(res, 404, { error: 'not found' })
  } catch (err) {
    return send(res, 500, { error: String(err?.message ?? err) })
  }
})

// Another session's server already serves the project: it is the notepad.
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err
  console.log('BUSY')
  process.exit(3)
})
server.on('listening', () => {
  const { port } = server.address()
  fs.writeFileSync(path.join(LOGS, 'notepad.json'), `${JSON.stringify({ token: TOKEN, port }, null, 2)}\n`, { mode: 0o600 })
  console.log(`NOTEPAD http://127.0.0.1:${port}/?t=${TOKEN}`)
})
server.listen(STABLE_PORT, '127.0.0.1')

// The mod's session owns this process; when its pipe closes, stop.
process.stdout.on('error', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
