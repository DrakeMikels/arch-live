// One-time repair for journals split by subfolder: before every folder
// resolved to its project root, a session pointed at <project>/test or
// <project>/public logged to its own journal folder beside the project's.
// This folds each such folder into its project root's journal and archives it.
//
//   node scripts/merge-journals.mjs            # show what it would do
//   node scripts/merge-journals.mjs --apply    # back up logs/, then do it
//
// Safe to run again: entries are matched by id, and a merged folder is moved
// out of logs/ (to ~/.claude/arch-live/merged/), so a second run finds nothing.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { folderProject, mergeDay, mergeSession, mergeWebLines, projectKey } from '../hooks/journal.ts'
import { projectRootOf } from '../hooks/project-root.ts'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const isApply = process.argv.includes('--apply')
const LOGS = path.resolve(arg('logs') ?? path.join(os.homedir(), '.claude', 'arch-live', 'logs'))
// Backups and archives go beside logs/, where the mod never reads.
const BASE = path.dirname(LOGS)
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
const readText = file => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
const DAY = /^\d{4}-\d{2}-\d{2}\.json$/
const WEB = /^\d{4}-\d{2}-\d{2}\.web\.jsonl$/

// Each journal folder whose project lies inside another project root.
const plan = []
for (const entry of fs.readdirSync(LOGS, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = path.join(LOGS, entry.name)
  const names = fs.readdirSync(dir)
  const paths = [readJson(path.join(dir, 'meta.json'))?.project, ...names.filter(n => DAY.test(n)).map(n => readJson(path.join(dir, n))?.project)]
  const project = folderProject(entry.name, paths)
  if (!project) continue
  const root = await projectRootOf(project, async p => fs.existsSync(p), os.homedir())
  if (root === project || projectKey(root) === entry.name) continue
  plan.push({ key: entry.name, dir, project, root, target: path.join(LOGS, projectKey(root)) })
}

if (plan.length === 0) {
  console.log('Nothing to merge: every journal folder is its project root’s own.')
  process.exit(0)
}
for (const p of plan) console.log(`${p.key}\n  ${p.project} is inside ${p.root}\n  → ${path.basename(p.target)}`)
if (!isApply) {
  console.log('\nDry run. Run again with --apply to merge (logs/ is backed up first).')
  process.exit(0)
}

const backup = path.join(BASE, 'backups', `logs-${STAMP}`)
fs.cpSync(LOGS, backup, { recursive: true })
console.log(`\nBacked up ${LOGS} to ${backup}`)

for (const p of plan) {
  const moved = []
  const kept = []
  for (const name of fs.readdirSync(p.dir)) {
    const from = path.join(p.dir, name)
    const to = path.join(p.target, name)
    if (DAY.test(name)) {
      const source = readJson(from)
      if (!source || !Array.isArray(source.entries)) continue
      const before = readJson(to)
      const merged = mergeDay(before && Array.isArray(before.entries) ? before : undefined, source, p.root)
      writeJson(to, merged)
      moved.push(`${name} (+${merged.entries.length - (before?.entries?.length ?? 0)} entries)`)
    } else if (WEB.test(name)) {
      const merged = mergeWebLines(readText(to), readText(from))
      fs.mkdirSync(p.target, { recursive: true })
      fs.writeFileSync(to, merged)
      moved.push(name)
    } else if (name === 'sessions' || name === 'standups' || name === 'boards') {
      for (const file of fs.readdirSync(from)) {
        const one = path.join(to, file)
        if (name === 'sessions' && file.endsWith('.json')) {
          const source = readJson(path.join(from, file))
          if (source?.id) writeJson(one, mergeSession(readJson(one), source))
          moved.push(`${name}/${file}`)
        } else if (!fs.existsSync(one)) {
          fs.mkdirSync(to, { recursive: true })
          fs.copyFileSync(path.join(from, file), one)
          moved.push(`${name}/${file}`)
        } else kept.push(`${name}/${file}`)
      }
    } else {
      // What the mod rebuilds (meta.json, live.svg, the notepad's port) or
      // this folder's own view state: archived, not merged.
      kept.push(name)
    }
  }
  const archive = path.join(BASE, 'merged', `${p.key}-${STAMP}`)
  fs.mkdirSync(path.dirname(archive), { recursive: true })
  fs.renameSync(p.dir, archive)
  console.log(`\n${p.key} → ${path.basename(p.target)}`)
  console.log(`  merged: ${moved.join(', ') || 'nothing'}`)
  if (kept.length) console.log(`  left in the archive only: ${kept.join(', ')}`)
  console.log(`  archived to ${archive}`)
}
