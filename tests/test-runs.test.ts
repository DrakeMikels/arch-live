import { describe, expect, test } from 'claude-code/testing'

import { testRun } from '../hooks/test-runs'

describe('testRun', () => {
  test('reads node --test', () => {
    const out = '✔ a test (1ms)\nℹ tests 43\nℹ suites 0\nℹ pass 42\nℹ fail 1\nℹ cancelled 0\n'
    expect(testRun('npm test', out)).toEqual({ passed: 42, failed: 1, command: 'npm test' })
  })

  test('reads bun test and claude plugin test', () => {
    expect(testRun('claude plugin test .', '(pass) x\n\n 110 pass\n 0 fail\nRan 110 tests across 10 files. [0.59s]')).toEqual({ passed: 110, failed: 0, command: 'claude plugin test .' })
  })

  test('reads jest and vitest', () => {
    expect(testRun('npx jest', 'Tests:       1 failed, 2 skipped, 12 passed, 15 total\nTime: 1s')?.passed).toBe(12)
    expect(testRun('npx jest', 'Tests:       1 failed, 2 skipped, 12 passed, 15 total')?.failed).toBe(1)
    expect(testRun('npx vitest run', ' Test Files  2 passed (2)\n      Tests  3 failed | 9 passed (12)')).toEqual({ passed: 9, failed: 3, command: 'npx vitest run' })
  })

  test('reads pytest, cargo, mocha and rspec', () => {
    expect(testRun('pytest', '========= 2 failed, 30 passed, 1 skipped in 0.42s =========')).toEqual({ passed: 30, failed: 2, command: 'pytest' })
    const cargo = 'test result: ok. 4 passed; 0 failed; 0 ignored\n\ntest result: FAILED. 6 passed; 1 failed; 0 ignored'
    expect(testRun('cargo test', cargo)).toEqual({ passed: 10, failed: 1, command: 'cargo test' })
    expect(testRun('npx mocha', '\n  14 passing (20ms)\n  2 failing\n')).toEqual({ passed: 14, failed: 2, command: 'npx mocha' })
    expect(testRun('rspec', '13 examples, 1 failure')).toEqual({ passed: 12, failed: 1, command: 'rspec' })
  })

  test('ignores colour codes', () => {
    expect(testRun('npm test', '\u001b[32mℹ pass 5\u001b[39m\n\u001b[31mℹ fail 0\u001b[39m')?.passed).toBe(5)
  })

  test('is no test run when nothing looks like a summary', () => {
    expect(testRun('ls', 'README.md\npackage.json')).toBeUndefined()
    expect(testRun('git log', 'Fix 3 passed tests\n')).toBeUndefined()
  })

  test('keeps the command short', () => {
    expect(testRun(`npm test -- ${'x'.repeat(200)}`, 'ℹ pass 1\nℹ fail 0')?.command.length).toBe(80)
  })
  test('a summary cut in half is no test run', () => {
    // `claude plugin test . | tail -2` keeps " 0 fail" but not " 128 pass".
    expect(testRun('claude plugin test . | tail -2', ' 0 fail\nRan 128 tests across 11 files. [0.79s]')).toBeUndefined()
    expect(testRun('npm test | tail -1', 'ℹ fail 0')).toBeUndefined()
  })

  test('a run of no tests is no test run', () => {
    expect(testRun('npm test', 'ℹ pass 0\nℹ fail 0')).toBeUndefined()
  })
})
