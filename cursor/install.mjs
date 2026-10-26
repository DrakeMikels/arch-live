// Installs arch-live into Cursor as a local plugin, pointing at this clone:
//
//   node cursor/install.mjs              install (or update) the plugin
//   node cursor/install.mjs --uninstall  remove it
//
// It writes ~/.cursor/plugins/local/arch-live/: the manifest, the MCP server
// (mcp.json), the hooks that log each turn (hooks/hooks.json), the rule that
// tells the agent when to call the tools, and the slash commands. The scripts
// they run stay in this clone, so `git pull` updates them; run this again
// after a pull to refresh the rule and commands. Then reload Cursor.

import '../notepad/ts-register.mjs'

const { execFileSync } = await import('node:child_process')
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const { fileURLToPath } = await import('node:url')
const { EXPORT_FILE } = await import('../hooks/constants.ts')
const { mapPrompt, SECTION, standupInstructions } = await import('../hooks/prompts.ts')
const { plainTools } = await import('../hooks/cursor.ts')

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(os.homedir(), '.cursor', 'plugins', 'local', 'arch-live')
const pkg = { name: 'arch-live', version: '0.1.0' }

if (process.argv.includes('--uninstall')) {
  fs.rmSync(DEST, { recursive: true, force: true })
  console.log(`Removed ${DEST}. Reload Cursor (Developer: Reload Window) to finish.`)
  process.exit(0)
}

// The node Cursor should run: the first on your shell's PATH that can load
// the TypeScript modules (22.6 or newer, with the flags below), else this one.
// A PATH entry is a stable link (e.g. /opt/homebrew/bin/node) that survives
// upgrades; Cursor started from the Dock may not see your PATH, so the full
// path goes in the config.
const versionOf = bin => {
  try {
    return execFileSync(bin, ['-v'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const isNewEnough = v => {
  const [major, minor] = v.replace(/^v/, '').split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 6)
}
const nodeBin = (() => {
  let onPath = []
  try {
    onPath = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'which -a node'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {}
  return [...onPath, process.execPath].find(bin => fs.existsSync(bin) && isNewEnough(versionOf(bin)))
})()
if (!nodeBin) {
  console.error(`arch-live needs Node 22.6 or newer for Cursor; none was found (this is ${process.version}).`)
  process.exit(1)
}
// Node 22.6 to 23.5 strips types only with the flag; newer ones accept it too.
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`
const script = name => path.join(REPO, 'cursor', 'scripts', name)
const write = (rel, text) => {
  const file = path.join(DEST, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
}
const json = value => JSON.stringify(value, null, 2)

fs.rmSync(DEST, { recursive: true, force: true })

write('.cursor-plugin/plugin.json', json({
  name: pkg.name,
  description: 'Live architecture diagram and work journal for your standup, with a browser notepad. Shares its map and journal with the arch-live Claude Code mod.',
  version: pkg.version,
  author: { name: 'Mike Drake' },
}))

write('mcp.json', json({ mcpServers: { 'arch-live': { command: nodeBin, args: [...NODE_FLAGS, script('mcp.mjs')] } } }))

const hook = (event, timeout = 10) => ({ command: [nodeBin, ...NODE_FLAGS, script('hook.mjs')].map(q).join(' ') + ` ${event}`, timeout })
write('hooks/hooks.json', json({
  version: 1,
  hooks: {
    sessionStart: [hook('sessionStart', 15)],
    beforeSubmitPrompt: [hook('beforeSubmitPrompt')],
    afterFileEdit: [hook('afterFileEdit')],
    afterShellExecution: [hook('afterShellExecution')],
    afterAgentResponse: [hook('afterAgentResponse')],
    stop: [hook('stop', 15)],
    sessionEnd: [hook('sessionEnd')],
  },
}))

write('rules/arch-live.mdc', [
  '---',
  'description: arch-live keeps a live architecture diagram and a work journal; call its tools as you work',
  'alwaysApply: true',
  '---',
  '',
  plainTools(SECTION.text).replace('This session shows', 'This workspace has'),
  '',
  'These tools come from the arch-live MCP server. The person opens the browser notepad (journal, diagram, board, standup, timeline, insights) with /notepad.',
].join('\n'))

// Slash commands: what the Claude Code mod's commands do, as prompts.
const here = "this workspace's root folder"
const commands = {
  'arch-map': plainTools(mapPrompt(here)).replace(`root: "${here}"`, `root: the full path of ${here}`),
  standup: [
    ...standupInstructions('all sessions', Date.now(), 'save_standup').map((line, i) => (i === 0 ? line.replace(/, since [^)]*\)/, ', since my last standup)') : line)),
    '',
    'For the journal, call standup_brief: it returns the brief and every turn and note in the window.',
  ].join('\n'),
  notepad: 'Call the arch-live open_notepad tool and give me the address it returns as a link. Nothing else.',
  'arch-export': `Call the arch-live arch_export tool to write the diagram to ${EXPORT_FILE}, then tell me in one line where it went and how to embed it in the README.`,
  n: 'Add the text after this command to my arch-live journal as my own note: call log_note with it (keep any @component tag in the text). Reply with one short line.',
  todo: 'Add the text after this command to my arch-live journal as a todo: call log_todo with it and from_person: true (keep any @component tag in the text). Reply with one short line.',
  blocker: 'Log the text after this command in my arch-live journal as a blocker: call log_blocker with it and from_person: true (keep any @component tag in the text). Reply with one short line.',
  decision: 'Log the text after this command in my arch-live journal as a decision: call log_decision with it as decision (split off a "because …" part as why) and from_person: true. Reply with one short line.',
  done: 'Close the open item in my arch-live journal that matches the text after this command: call log_todo with it and done: true; if no todo matches, call log_blocker with it and resolved: true. Both with from_person: true. Reply with one short line.',
}
for (const [name, text] of Object.entries(commands)) write(`commands/${name}.md`, text)

write('README.md', [
  '# arch-live for Cursor',
  '',
  `Generated by ${path.join(REPO, 'cursor', 'install.mjs')}; its scripts run from that clone with ${nodeBin}.`,
  'Run the installer again after updating the clone, then reload Cursor.',
].join('\n'))

console.log(`Installed arch-live into ${DEST}`)
console.log(`  scripts: ${path.join(REPO, 'cursor', 'scripts')}`)
console.log(`  node:    ${nodeBin} (${versionOf(nodeBin)})`)
console.log('Next: in Cursor, run "Developer: Reload Window", then open Customize to check that the arch-live rule, MCP server and commands are listed.')
