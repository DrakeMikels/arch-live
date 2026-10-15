// Which project a folder belongs to, so a session or a tool call that points
// at a subfolder (test/, public/) still files its map and journal under the
// project: the nearest folder up with a map, else the nearest git root, else
// the folder itself. Plain path strings and an `exists` check, so the hooks
// (through $.fs) and the notepad server (through node:fs) share it.

const MAP_FILE = '.claude/architecture.json'

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

// The folder and each one above it, nearest first.
export const ancestorsOf = (abs: string): string[] => {
  const out: string[] = []
  let dir = trimSlash(abs)
  while (dir) {
    out.push(dir)
    if (dir === '/') break
    const cut = dir.lastIndexOf('/')
    dir = cut <= 0 ? '/' : dir.slice(0, cut)
  }
  return out
}

/**
 * The project root of an absolute folder. `home`, when given, is never a root
 * for a folder below it (a dotfiles repo or a stray map in ~ would swallow
 * every project), and nothing above it is either.
 */
export const projectRootOf = async (abs: string, exists: (path: string) => Promise<boolean>, home?: string): Promise<string> => {
  const start = trimSlash(abs)
  const top = home ? trimSlash(home) : undefined
  const isBelowHome = top !== undefined && start.startsWith(`${top}/`)
  const candidates = ancestorsOf(start).filter(dir => !isBelowHome || dir.startsWith(`${top}/`))
  const has = (dir: string, name: string) => exists(dir === '/' ? `/${name}` : `${dir}/${name}`).catch(() => false)
  for (const dir of candidates) if (await has(dir, MAP_FILE)) return dir
  for (const dir of candidates) if (await has(dir, '.git')) return dir
  return start
}
