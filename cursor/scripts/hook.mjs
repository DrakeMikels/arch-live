// arch-live's Cursor hooks: each agent turn becomes one journal entry, as the
// Claude Code mod logs them. `node hook.mjs <event>` reads Cursor's JSON on
// stdin and always answers (exit 0, JSON on stdout), so a failure here never
// blocks the agent.
//
//   sessionStart        the notepad is started for the project
//   beforeSubmitPrompt  a turn begins: its request, and the map as it stands
//   afterFileEdit       a file the turn changed
//   afterShellExecution a command it ran, and its tests' counts
//   afterAgentResponse  what it answered (the turn's summary)
//   stop                the turn is written to the journal
//   sessionEnd          the chat is marked ended

import '../../notepad/ts-register.mjs'

const event = process.argv[2] ?? ''
const answer = value => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exit(0)
}
const okFor = { beforeSubmitPrompt: { continue: true } }

let input = {}
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
} catch {
  answer(okFor[event] ?? {})
}

try {
  const core = await import('./core.mjs')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const { GRAPH_FILE } = await import('../../hooks/constants.ts')
  const { newDraft, cursorTurn } = await import('../../hooks/cursor.ts')
  const { distill } = await import('../../hooks/ste.ts')
  const { newId } = await import('../../hooks/journal.ts')
  const { testRun } = await import('../../hooks/test-runs.ts')

  const folder = input.workspace_roots?.[0] ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd()
  const root = await core.projectOf(folder)
  const logs = core.logsDirOf(root)
  const conversation = String(input.conversation_id ?? input.session_id ?? '')
  const draftFile = path.join(logs, 'cursor-turns', `${conversation.replace(/[^\w-]/g, '') || 'chat'}.json`)
  const readDraft = () => core.readJson(draftFile, null)
  const saveDraft = draft => core.writeJson(draftFile, draft)
  const relative = file => {
    const abs = path.isAbsolute(file) ? file : path.join(root, file)
    return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs
  }

  if (event === 'sessionStart') {
    core.changeSession(logs, conversation, s => s)
    await core.ensureNotepad(root, logs, conversation)
  } else if (event === 'beforeSubmitPrompt') {
    const prompt = String(input.prompt ?? '').trim()
    core.rememberActive(root, conversation)
    if (prompt) {
      saveDraft(newDraft(Date.now(), prompt, core.readGraph(root)))
      // The chat is named after its first request, as the mod names a session.
      const first = distill(prompt, { mode: 'request', max: 1 }).statements[0]?.text ?? prompt
      core.changeSession(logs, conversation, s => (s.name ? s : { ...s, name: first.replace(/\s+/g, ' ').trim().slice(0, 48) }))
      await core.ensureNotepad(root, logs, conversation, { wait: false })
    }
  } else if (event === 'afterFileEdit') {
    const draft = readDraft()
    const rel = relative(String(input.file_path ?? ''))
    if (draft && rel && !rel.endsWith(GRAPH_FILE)) {
      const edits = Array.isArray(input.edits) ? input.edits : []
      // A first edit that replaces nothing with everything wrote a new file.
      const isNew = edits.length === 1 && !edits[0]?.old_string && !draft.files[rel]
      const was = draft.files[rel] ?? { path: rel, created: isNew, edits: 0 }
      draft.files[rel] = { ...was, edits: was.edits + 1 }
      saveDraft(draft)
    }
  } else if (event === 'afterShellExecution') {
    const draft = readDraft()
    if (draft) {
      draft.commands += 1
      const run = testRun(String(input.command ?? ''), String(input.output ?? ''))
      if (run) draft.tests = run
      saveDraft(draft)
    }
  } else if (event === 'afterAgentResponse') {
    const draft = readDraft()
    if (draft && input.text) {
      draft.answer = String(input.text)
      saveDraft(draft)
    }
  } else if (event === 'stop') {
    const draft = readDraft()
    if (draft) {
      const graph = core.readGraph(root)
      const entry = cursorTurn(draft, graph, newId(draft.ts), conversation)
      if (entry) core.appendEntry(logs, root, entry)
      fs.rmSync(draftFile, { force: true })
      core.changeSession(logs, conversation, ({ endedAt: _ended, ...open }) => open)
      core.publishLive(root, logs)
    }
  } else if (event === 'sessionEnd') {
    core.changeSession(logs, conversation, s => ({ ...s, endedAt: Date.now() }))
  }
} catch (err) {
  process.stderr.write(`arch-live ${event}: ${err?.stack ?? err}\n`)
}
answer(okFor[event] ?? {})
