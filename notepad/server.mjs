// arch-live notepad: a local, dependency-free server for the browser view of
// the work journal. The mod starts it per session (`node server.mjs --logs
// <dir> --project <path> --session <id>`) and stops it with the session.
// Every session on a project shares the logs folder, so each notepad sees
// the others' turns, notes and boards live. It binds 127.0.0.1
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

const TOKEN = randomBytes(12).toString('hex')
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
const sessionNames = () => Object.fromEntries(sessions().filter(s => s.name).map(s => [s.id, s.name]))

// Tells the mod (which reads this process's output) to refresh its pane.
const changed = () => process.stdout.write('CHANGED\n')

// Hands the mod a request for Claude (describe a component, read a board).
const ask = request => process.stdout.write(`ASK ${JSON.stringify(request)}\n`)

const append = entry => {
  fs.appendFileSync(path.join(LOGS, `${dateKey(entry.ts)}.web.jsonl`), `${JSON.stringify(entry)}\n`)
  changed()
}

const state = date => {
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
    self: SELF,
    sessions: sessions(),
    open: openItems(days),
    labels: Object.fromEntries(labelsFrom(days, g)),
  }
}

const workspace = createWorkspace({ project: PROJECT, logs: LOGS, graph, recent })

const standup = () => {
  const now = Date.now()
  const last = Number(readJson(path.join(LOGS, 'standup.json'), {}).last ?? 0)
  const since = last > now - 14 * DAY_MS ? last : now - DAY_MS
  const g = graph()
  return buildStandup({ title: g?.title ?? meta().title, since, now, days: recent(), graph: g, sessions: sessionNames() })
}

const addNote = ({ type, text, component }) => {
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
    ...(SELF ? { session: SELF } : {}),
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
  const token = url.searchParams.get('t') ?? req.headers['x-notepad-token']
  if (token !== TOKEN) return send(res, 403, { error: 'missing or wrong token' })

  try {
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
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state(url.searchParams.get('date')))
    if (req.method === 'GET' && url.pathname === '/api/standup') {
      return send(res, 200, { markdown: standup(), written: readJson(path.join(LOGS, 'standup-written.json'), null), last: Number(readJson(path.join(LOGS, 'standup.json'), {}).last ?? 0), hasSession: !!SELF })
    }
    if (req.method === 'GET' && url.pathname === '/live.svg') {
      return send(res, 200, readText(path.join(LOGS, 'live.svg')) || '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')
    }
    if (req.method === 'POST' && url.pathname === '/api/note') return send(res, 200, addNote(await readBody(req)))
    if (req.method === 'GET' && url.pathname === '/api/component') {
      const found = await workspace.component(url.searchParams.get('id'))
      return found ? send(res, 200, found) : send(res, 404, { error: 'no such component' })
    }
    if (req.method === 'GET' && url.pathname === '/api/symbols') return send(res, 200, workspace.symbols(url.searchParams.get('path') ?? ''))
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readBody(req)
      // The mod builds the standup prompt itself, from the same journal.
      if (body.kind === 'standup') {
        ask({ kind: 'standup', scope: body.scope === 'session' ? 'session' : 'all' })
        return send(res, 200, { ok: true })
      }
      if (body.kind !== 'describe' || typeof body.component !== 'string') return send(res, 400, { error: 'unknown request' })
      const found = await workspace.component(body.component)
      const missing = (found?.files ?? []).filter(f => !f.summary || f.isStale).map(f => f.path).slice(0, 40)
      ask({ kind: 'describe', component: body.component, label: found?.node.label ?? body.component, files: missing })
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
        session: prev?.session ?? (typeof body.session === 'string' ? body.session : SELF),
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
      ask({
        kind: 'board',
        title: String(body.title ?? 'Board').slice(0, 120),
        png: `${base}.png`,
        md: String(body.md ?? '').slice(0, 60_000),
        note: String(body.note ?? '').slice(0, 4000),
        target: typeof body.target === 'string' ? body.target : SELF,
        targetName: sessionNames()[body.target] ?? undefined,
      })
      return send(res, 200, { ok: true, png: `${base}.png` })
    }
    if (req.method === 'POST' && url.pathname === '/api/done') {
      const { ref } = await readBody(req)
      if (typeof ref !== 'string') return send(res, 400, { error: 'ref is required' })
      append({ id: newId(Date.now()), ts: Date.now(), type: 'done', ref, by: 'you', ...(SELF ? { session: SELF } : {}) })
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/open') {
      const { path: file, line } = await readBody(req)
      if (typeof file !== 'string') return send(res, 400, { error: 'path is required' })
      return send(res, 200, { ok: await openCode(file, line) })
    }
    if (req.method === 'POST' && url.pathname === '/api/standup/given') {
      fs.writeFileSync(path.join(LOGS, 'standup.json'), `${JSON.stringify({ last: Date.now() })}\n`)
      changed()
      broadcast()
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: 'not found' })
  } catch (err) {
    return send(res, 500, { error: String(err?.message ?? err) })
  }
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  console.log(`NOTEPAD http://127.0.0.1:${port}/?t=${TOKEN}`)
})

// The mod's session owns this process; when its pipe closes, stop.
process.stdout.on('error', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
