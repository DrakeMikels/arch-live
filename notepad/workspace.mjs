// What the notepad's Diagram drawer and Board tab read: each component's files
// (from git), an outline of a file's functions, and the saved whiteboards.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { componentFor, dateKey } from '../hooks/journal.ts'

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '__pycache__', '.venv'])
const FILE_LIMIT = 800

const isFileLike = p => /\.[a-z0-9]+$/i.test(p.split('/').pop() ?? '')

// The folders a component owns: its `owns`, else its entry file's folder.
const ownedDirs = node => {
  if (node.owns?.length) return node.owns
  if (!node.path) return []
  return [isFileLike(node.path) ? node.path.split('/').slice(0, -1).join('/') || node.path : node.path]
}

// Top-level functions, classes and handlers by a light per-line scan: an
// outline for reading, not a parser.
const RULES = {
  js: [
    [/^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function', true],
    [/^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, 'function', true],
    [/^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function/, 'function', true],
    [/^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class', true],
    [/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/, 'type', true],
    [/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function', false],
    [/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, 'function', false],
    [/^class\s+([A-Za-z_$][\w$]*)/, 'class', false],
  ],
  py: [
    [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function', true],
    [/^class\s+([A-Za-z_]\w*)/, 'class', true],
    [/^ {4}(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'method', false],
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function', true],
    [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type', true],
  ],
  swift: [
    [/^\s*(?:@\w+\s+)*(?:public |open |internal |private |fileprivate )?(?:static |final )*func\s+([A-Za-z_]\w*)/, 'function', true],
    [/^\s*(?:public |open |internal |private |fileprivate )?(?:final )?(?:class|struct|enum|actor|protocol)\s+([A-Za-z_]\w*)/, 'type', true],
  ],
  rb: [
    [/^\s*def\s+((?:self\.)?[\w?!]+)/, 'method', true],
    [/^\s*(?:class|module)\s+([A-Z][\w:]*)/, 'class', true],
  ],
  sql: [[/create\s+(?:or\s+replace\s+)?(?:table|function|view|policy|index|trigger|type)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, 'object', true]],
}
const LANG = { ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', py: 'py', go: 'go', swift: 'swift', rb: 'rb', sql: 'sql' }

// The first sentence of a file's own header comment or docstring, if any.
const TRIPLE = /^("{3}|'{3})/
const headerDoc = lines => {
  const out = []
  let inBlock = false
  for (const raw of lines.slice(0, 40)) {
    const line = raw.trim()
    if (!out.length && !inBlock && (!line || line.startsWith('#!') || /^['"]use (strict|client|server)['"];?$/.test(line))) continue
    if (inBlock) {
      out.push(line.replace(/\*\/.*$/, '').replace(/^\*\s?/, ''))
      if (line.includes('*/')) break
      continue
    }
    if (line.startsWith('/*')) {
      out.push(line.replace(/^\/\*+\s?/, '').replace(/\*\/.*$/, ''))
      if (line.includes('*/')) break
      inBlock = true
      continue
    }
    if (line.startsWith('//') || line.startsWith('#') || line.startsWith('--')) {
      out.push(line.replace(/^(\/\/+|#+|--+)\s?/, ''))
      continue
    }
    if (TRIPLE.test(line)) {
      out.push(line.replace(TRIPLE, '').replace(/("{3}|'{3}).*$/, ''))
      break
    }
    break
  }
  const text = out.join(' ').replace(/@\w+.*$/, '').replace(/\s+/g, ' ').trim()
  if (!text || /copyright|license|eslint|prettier|@ts-/i.test(text)) return null
  return /^(.{20,200}?[.!?])(\s|$)/.exec(text)?.[1] ?? text.slice(0, 200)
}

export const createWorkspace = ({ project, logs, graph, recent }) => {
  const git = args =>
    new Promise(resolve => {
      execFile('git', ['-C', project, ...args], { maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err ? null : out))
    })

  // Files under `dirs` when the project is not a git repo.
  const walk = (dirs, limit) => {
    const out = []
    const visit = (rel, depth) => {
      if (out.length >= limit || depth > 8) return
      let entries = []
      try {
        entries = fs.readdirSync(path.join(project, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue
        const child = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) visit(child, depth + 1)
        else if (e.isFile()) out.push(child)
        if (out.length >= limit) return
      }
    }
    for (const d of dirs) {
      const abs = path.join(project, d)
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.push(d)
      else visit(d, 0)
    }
    return out
  }

  const mtime = rel => {
    try {
      return fs.statSync(path.join(project, rel)).mtimeMs
    } catch {
      return 0
    }
  }

  const component = async id => {
    const node = graph()?.nodes?.find(n => n.id === id)
    if (!node) return null
    const owns = ownedDirs(node)
    const [listed, status] = owns.length
      ? await Promise.all([
          git(['ls-files', '--cached', '--others', '--exclude-standard', '--', ...owns]),
          git(['status', '--porcelain', '--', ...owns]),
        ])
      : ['', '']
    // A file belongs to the component owning it most specifically, so the Web
    // app owning app/ does not list app/api, which the API routes own.
    const g = graph()
    const listedFiles = listed === null ? walk(owns, FILE_LIMIT * 4) : [...new Set(listed.split('\n').filter(Boolean))]
    const all = listedFiles.filter(f => (componentFor(g, f) ?? id) === id)
    const uncommitted = new Set((status ?? '').split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, '')))
    const days = recent()
    const today = days.find(d => d.date === dateKey(Date.now()))
    const touchedToday = new Set((today?.entries ?? []).filter(e => e.type === 'turn').flatMap(t => t.files.map(f => f.path)))
    const summaries = node.files ?? {}
    return {
      node: { id: node.id, label: node.label, kind: node.kind, sublabel: node.sublabel ?? '', path: node.path ?? null, line: node.line ?? null },
      breakdown: node.breakdown ?? null,
      // Its neighbours on the map, drawn at the edges of the zoomed-in view.
      callers: (g?.edges ?? []).filter(e => e.to === id).map(e => ({ id: e.from, label: g.nodes.find(n => n.id === e.from)?.label ?? e.from, kind: g.nodes.find(n => n.id === e.from)?.kind ?? 'service', edge: e.label ?? '' })),
      callees: (g?.edges ?? []).filter(e => e.from === id).map(e => ({ id: e.to, label: g.nodes.find(n => n.id === e.to)?.label ?? e.to, kind: g.nodes.find(n => n.id === e.to)?.kind ?? 'service', edge: e.label ?? '' })),
      owns,
      total: all.length,
      truncated: all.length > FILE_LIMIT,
      files: all.slice(0, FILE_LIMIT).map(f => {
        const s = summaries[f]
        return {
          path: f,
          summary: s?.summary ?? null,
          isStale: !!s && mtime(f) > s.at + 1000,
          isChanged: uncommitted.has(f),
          isToday: touchedToday.has(f),
          isEntry: f === node.path,
        }
      }),
      // Every mark on it, newest first, cleared ones included, for the drawer.
      marks: days
        .flatMap(d => d.entries.filter(e => e.type === 'mark' && e.component === id).map(e => ({ ...e, date: d.date })))
        .sort((a, b) => b.ts - a.ts),
      recent: days
        .flatMap(d => d.entries)
        .filter(e => e.type === 'turn' && e.components.includes(id))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 6)
        .map(t => ({ ts: t.ts, request: t.request, summary: t.summary[0] ?? '' })),
    }
  }

  const symbols = rel => {
    const abs = path.resolve(project, rel)
    if (!abs.startsWith(path.resolve(project) + path.sep)) return { symbols: [], doc: null }
    let text = ''
    try {
      if (fs.statSync(abs).size > 512 * 1024) return { symbols: [], doc: null, isLarge: true }
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      return { symbols: [], doc: null }
    }
    const lines = text.split('\n')
    const rules = RULES[LANG[(rel.split('.').pop() ?? '').toLowerCase()]] ?? []
    const found = []
    lines.forEach((line, i) => {
      for (const [re, kind, exported] of rules) {
        const m = re.exec(line)
        if (m) {
          found.push({ name: m[1], kind, line: i + 1, exported })
          break
        }
      }
    })
    return { symbols: found.slice(0, 80), doc: headerDoc(lines), lines: lines.length }
  }

  const boardsDir = path.join(logs, 'boards')
  const boardFile = id => path.join(boardsDir, `${String(id).replace(/[^\w-]/g, '')}.json`)
  const listBoards = () => {
    try {
      return fs
        .readdirSync(boardsDir)
        .filter(n => n.endsWith('.json'))
        .map(n => {
          const b = JSON.parse(fs.readFileSync(path.join(boardsDir, n), 'utf8'))
          return { id: n.replace(/\.json$/, ''), title: b.title ?? 'Untitled', session: b.session ?? null, updatedAt: b.updatedAt ?? 0 }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  // A quick look at a component before Claude breaks it down: its top-level
  // folders and files, largest first, with what their files do.
  const quickParts = found => {
    const groups = new Map()
    const owns = [...found.owns].sort((a, b) => b.length - a.length)
    for (const f of found.files) {
      const base = owns.find(o => f.path === o || f.path.startsWith(`${o}/`)) ?? ''
      const rest = base && f.path !== base ? f.path.slice(base.length + 1) : f.path.slice(base.length)
      const isDir = rest.includes('/')
      const key = !rest ? base : isDir ? `${base ? `${base}/` : ''}${rest.split('/')[0]}` : f.path
      if (!groups.has(key)) groups.set(key, { files: [], isDir })
      groups.get(key).files.push(f)
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].files.length - a[1].files.length)
      .slice(0, 10)
      .map(([key, g]) => {
        const described = g.files.find(f => f.summary)
        return {
          id: `q:${key}`,
          label: `${key.split('/').pop()}${g.isDir ? '/' : ''}`,
          path: g.isDir ? g.files[0].path : key,
          summary: g.files.length === 1 ? (described?.summary ?? '') : `${g.files.length} files${described ? ` · ${described.summary}` : ''}`,
        }
      })
  }

  // The whole map for the notepad's canvas: every component with its parts.
  const map = async () => {
    const g = graph()
    if (!g) return { nodes: [], edges: [] }
    const nodes = await Promise.all(
      g.nodes.map(async n => {
        const found = n.breakdown?.parts?.length ? null : await component(n.id)
        return {
          id: n.id, label: n.label, kind: n.kind, sublabel: n.sublabel ?? '', path: n.path ?? null, line: n.line ?? null, order: n.order ?? 0,
          breakdown: n.breakdown ?? null,
          quick: found ? quickParts(found) : [],
        }
      }),
    )
    return { title: g.title ?? '', nodes, edges: g.edges ?? [], focus: g.focus ?? [] }
  }

  // Where the map no longer matches the code: a component's entry or folders
  // gone, top-level folders of tracked code that no component owns, and
  // breakdowns whose files changed (or went) after Claude wrote them.
  const NOT_CODE = new Set(['.git', '.github', '.vscode', '.idea', '.claude', '.claude-plugin', 'node_modules', 'dist', 'build', 'coverage', 'docs', 'doc', '.next', '.turbo', 'tmp', 'vendor', 'public', 'assets', 'static', 'test', 'tests', '__tests__', 'scripts', 'data'])
  const exists = rel => fs.existsSync(path.join(project, rel))
  const drift = async () => {
    const g = graph()
    const issues = []
    if (!g?.nodes?.length) return { issues, checkedAt: Date.now() }
    for (const n of g.nodes) {
      for (const p of [n.path, ...(n.owns ?? [])].filter(Boolean)) {
        if (!exists(p)) issues.push({ kind: 'missing', node: n.id, label: n.label, path: p })
      }
      if (n.breakdown?.parts?.length) {
        const files = [...new Set(n.breakdown.parts.map(p => p.path).filter(Boolean))]
        const changed = files.filter(f => !exists(f) || mtime(f) > n.breakdown.at + 1000)
        if (changed.length) issues.push({ kind: 'breakdown', node: n.id, label: n.label, files: changed })
      }
    }
    const listed = await git(['ls-files'])
    if (listed) {
      const counts = new Map()
      for (const f of listed.split('\n').filter(Boolean)) {
        const top = f.split('/')[0]
        if (!f.includes('/') || top.startsWith('.') || NOT_CODE.has(top)) continue
        if (componentFor(g, f)) continue
        counts.set(top, (counts.get(top) ?? 0) + 1)
      }
      for (const [folder, files] of counts) if (files >= 2) issues.push({ kind: 'unmapped', folder, files })
    }
    return { issues, checkedAt: Date.now(), mapAt: g.updatedAt ?? 0 }
  }

  return { component, symbols, boardsDir, boardFile, listBoards, map, drift }
}
