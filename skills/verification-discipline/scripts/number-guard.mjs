#!/usr/bin/env node
/**
 * number-guard.mjs — block generated numbers that are absent from the source data.
 *
 * Why this exists: "explain the trend from this data" plus "do not make up numbers"
 * is a self-contradicting instruction. With no real figures in context, the only way
 * to satisfy both is to invent one. Prompt rules do not stop it. A post-generation
 * check does.
 *
 * Three mistakes this implementation avoids, each of which produced a false pass
 * in earlier versions:
 *   1. Normalizing only one side. Output "87 orders" vs source "87orders" flagged a
 *      correct number as fabricated.
 *   2. Substring comparison. "3M" passes when the source says "13M", because
 *      includes() matches inside a longer number. Compare tokens, not substrings.
 *   3. Unit coverage. A regex that only knows one language's units silently matches
 *      nothing, and a guard that matches nothing always passes.
 *
 * Usage:
 *   import { guardNumbers } from './number-guard.mjs'
 *   guardNumbers(modelOutput, sourceText)          // throws on unsourced numbers
 *   guardNumbers(modelOutput, sourceText, { throwOnFail: false })  // returns the list
 *
 * Run this file directly to self-test. It covers both English and Chinese cases.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Strip separators and whitespace from BOTH sides before comparing, and fold
// currency notation: "$1,234" and "1234 USD" are the same figure written two ways,
// and flagging one as fabricated because of notation is a false positive that will
// make people disable the guard.
const CURRENCY = /^(?:us\$|nt\$|[$€£])|(?:usd|twd|eur|gbp)$/gi
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[,\s，、]/g, '')
    .replace(CURRENCY, '')

/**
 * A number, optional magnitude, optional unit.
 * Covers English and Chinese units plus currency symbols. Extend UNITS for your domain.
 */
const MAGNITUDE = String.raw`(?:萬|億|千|[kKmMbB]n?|bn|billion|million|thousand)?`
const UNITS = String.raw`(?:%|％|筆|次|人|元|天|個|小時|分鐘|orders?|users?|items?|days?|hours?|minutes?|customers?|records?|USD|NT\$|US\$|\$|€|£)?`
const NUM = new RegExp(String.raw`[$€£]?\d[\d,.]*\s*${MAGNITUDE}\s*${UNITS}`, 'gi')

/** Tokenize a text into the same shape the output is measured in. */
function tokenize(text) {
  return new Set((String(text).match(NUM) || []).map(norm).filter((t) => /\d/.test(t)))
}

/**
 * Returns numbers present in `output` that do not appear in `sourceText`.
 * Comparison is token equality, not substring containment.
 */
export function findUnsourcedNumbers(output, sourceText) {
  const sourceTokens = tokenize(sourceText)
  const claimed = String(output).match(NUM) || []
  const unknown = claimed.filter((raw) => {
    const t = norm(raw)
    if (!/\d/.test(t)) return false
    return !sourceTokens.has(t)
  })
  return [...new Set(unknown)]
}

export function guardNumbers(output, sourceText, { throwOnFail = true } = {}) {
  const unknown = findUnsourcedNumbers(output, sourceText)
  if (unknown.length && throwOnFail) {
    throw new Error(`Output contains numbers absent from the source: ${unknown.join(', ')}`)
  }
  return unknown
}

// ── Self-test ────────────────────────────────────────────────────────────────
// Compare resolved paths. Do not hand-build a `file://` string: on Windows the
// drive letter and backslashes make that comparison never true, so the self-test
// would silently never run and report nothing at all.
const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])

if (isMain) {
  const cases = [
    // [name, model output, source data, should be flagged]
    ['exact match (en)', 'We processed 87 orders', 'order count: 87 orders', false],
    ['whitespace differs (en)', 'processed 87 orders', '87orders', false],
    ['thousands separator (en)', 'revenue was $1,234', 'revenue 1234 USD', false],
    ['magnitude match (en)', 'grew to 4.2M users', 'user base 4.2M users', false],
    ['fabricated percentage (en)', 'growth was 42%', 'growth was 15%', true],
    ['fabricated magnitude (en)', 'revenue hit $500,000', 'revenue $12,000', true],
    ['substring trap (en)', 'we saw 87 orders', 'we saw 187 orders', true],
    ['substring trap, decimal (en)', 'margin of 3.5%', 'margin of 13.5%', true],
    ['exact match (zh)', '共 87 筆訂單', '訂單數 87筆', false],
    ['thousands separator (zh)', '營收 1,234 元', '營收 1234 元', false],
    ['magnitude match (zh)', '營收 3 萬元', '營收 3萬元', false],
    ['fabricated magnitude (zh)', '營收達 500 萬元', '營收 12 萬元', true],
    ['substring trap (zh)', '營收 3 萬元', '營收 13 萬元', true],
    ['no numbers at all', 'revenue grew substantially', 'revenue 12000', false],
  ]

  let failed = 0
  for (const [name, out, src, shouldFlag] of cases) {
    const flagged = findUnsourcedNumbers(out, src)
    const ok = flagged.length > 0 === shouldFlag
    if (!ok) failed++
    const verdict = flagged.length ? `flagged [${flagged.join(', ')}]` : 'passed through'
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${verdict} (expected ${shouldFlag ? 'flag' : 'pass'})`)
  }

  // Positive control on the guard itself: a regex that matches nothing would make
  // every case "pass". Prove the tokenizer actually sees numbers.
  const sanity = tokenize('87 orders, $1,234, 42%, 3萬元')
  if (sanity.size < 4) {
    console.log(`\nABORT: tokenizer only found ${sanity.size} numbers in a string with 4. The regex is broken.`)
    process.exit(2)
  }

  console.log(failed ? `\n${failed} case(s) behaved unexpectedly. Fix before relying on this guard.` : '\nAll cases behaved as expected. Guard is usable.')
  process.exit(failed ? 1 : 0)
}
