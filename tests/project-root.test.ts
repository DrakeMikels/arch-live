import { describe, expect, test } from 'claude-code/testing'

import { ancestorsOf, projectRootOf } from '../hooks/project-root'

const HOME = '/Users/me'
const disk = (...paths: string[]) => {
  const set = new Set(paths)
  return async (p: string) => set.has(p)
}

describe('ancestorsOf', () => {
  test('lists the folder and every one above it, nearest first', () => {
    expect(ancestorsOf('/a/b/c/')).toEqual(['/a/b/c', '/a/b', '/a', '/'])
    expect(ancestorsOf('/')).toEqual(['/'])
  })
})

describe('projectRootOf', () => {
  const project = `${HOME}/Dev Projects/app`

  test('a subfolder resolves to the folder up with the map', async () => {
    const exists = disk(`${project}/.claude/architecture.json`, `${project}/.git`)
    expect(await projectRootOf(`${project}/test`, exists, HOME)).toBe(project)
    expect(await projectRootOf(`${project}/public/img/`, exists, HOME)).toBe(project)
    expect(await projectRootOf(project, exists, HOME)).toBe(project)
  })

  test('the nearest map wins over a git root further up', async () => {
    const pkg = `${project}/packages/api`
    const exists = disk(`${pkg}/.claude/architecture.json`, `${project}/.git`)
    expect(await projectRootOf(`${pkg}/src`, exists, HOME)).toBe(pkg)
  })

  test('without a map, the git root', async () => {
    const exists = disk(`${project}/.git`)
    expect(await projectRootOf(`${project}/test`, exists, HOME)).toBe(project)
  })

  test('without a map or git, the folder itself', async () => {
    expect(await projectRootOf(`${project}/test`, disk(), HOME)).toBe(`${project}/test`)
  })

  test('home is never the root of a folder below it', async () => {
    const exists = disk(`${HOME}/.git`, `${HOME}/.claude/architecture.json`)
    expect(await projectRootOf(`${project}/test`, exists, HOME)).toBe(`${project}/test`)
    expect(await projectRootOf(HOME, exists, HOME)).toBe(HOME)
  })

  test('a failing check counts as missing', async () => {
    const exists = async (p: string) => {
      if (p.endsWith('architecture.json')) throw new Error('EACCES')
      return p === `${project}/.git`
    }
    expect(await projectRootOf(`${project}/test`, exists, HOME)).toBe(project)
  })
})
