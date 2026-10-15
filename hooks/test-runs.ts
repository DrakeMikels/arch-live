import type { JournalTests } from '../types'

// A test run's counts, from what a test command printed. Each runner prints a
// summary of its own; the counts of every summary line found are added up
// (cargo prints one per test binary). Output with no summary is no test run.

// isTotal: the passed count is every test, failures included. isPaired: the
// runner prints passed and failed on lines of their own, so a summary missing
// either one was cut off (by `tail`, say) and is no test run.
type Rule = { line: RegExp; passed?: RegExp; failed?: RegExp; isTotal?: boolean; isPaired?: boolean }

const RULES: Rule[] = [
  // node --test: "ℹ pass 43" / "ℹ fail 0"; TAP: "# pass 43".
  { line: /^(?:ℹ|#) (?:pass|fail) \d+$/, passed: /^(?:ℹ|#) pass (\d+)$/, failed: /^(?:ℹ|#) fail (\d+)$/, isPaired: true },
  // bun test, claude plugin test: " 110 pass" / " 0 fail".
  { line: /^\s*\d+ (?:pass|fail)$/, passed: /^\s*(\d+) pass$/, failed: /^\s*(\d+) fail$/, isPaired: true },
  // jest "Tests:  1 failed, 12 passed, 13 total"; vitest "Tests  1 failed | 12 passed (13)".
  { line: /^\s*Tests:?\s+.*\d+ (?:passed|failed)/, passed: /(\d+) passed/, failed: /(\d+) failed/ },
  // pytest "===== 1 failed, 12 passed in 0.31s =====".
  { line: /^=+ .*\d+ (?:passed|failed).* in [\d.]+s/, passed: /(\d+) passed/, failed: /(\d+) failed/ },
  // cargo "test result: ok. 12 passed; 0 failed; ...".
  { line: /^test result: \w+\. \d+ passed; \d+ failed/, passed: /(\d+) passed/, failed: /(\d+) failed/ },
  // mocha "12 passing" / "1 failing".
  { line: /^\s*\d+ (?:passing|failing)\b/, passed: /^\s*(\d+) passing/, failed: /^\s*(\d+) failing/ },
  // rspec "13 examples, 1 failure".
  { line: /^\d+ examples?, \d+ failures?/, passed: /^(\d+) examples?/, failed: /(\d+) failures?/, isTotal: true },
]

// Strips colour codes, which some runners print even into a pipe.
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '')

export const testRun = (command: string, output: string): JournalTests | undefined => {
  const lines = plain(output).split('\n').map(l => l.trimEnd())
  for (const rule of RULES) {
    const hits = lines.filter(l => rule.line.test(l))
    if (!hits.length) continue
    if (rule.isPaired && !(hits.some(l => rule.passed?.test(l)) && hits.some(l => rule.failed?.test(l)))) return undefined
    let passed = 0
    let failed = 0
    for (const l of hits) {
      passed += Number(rule.passed?.exec(l)?.[1] ?? 0)
      failed += Number(rule.failed?.exec(l)?.[1] ?? 0)
    }
    if (rule.isTotal) passed -= failed
    if (passed + failed === 0) return undefined
    return { passed: Math.max(0, passed), failed, command: command.replace(/\s+/g, ' ').trim().slice(0, 80) }
  }
  return undefined
}
