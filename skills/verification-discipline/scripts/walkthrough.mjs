#!/usr/bin/env node
/**
 * walkthrough.mjs — drive the path a user actually walks, and keep screenshots.
 *
 * Why: code review cannot see white text on a white background, a submit button
 * wired to nothing, or a database rule that was never added. Every line is valid in
 * isolation; only the composed result is broken. Two things catch this class of bug:
 * a person opening the page, or a script that opens it and screenshots each step.
 *
 * Install:
 *   npm i playwright && npx playwright install chromium
 *
 * Usage:
 *   node walkthrough.mjs <url> [outDir]
 *
 * Configure via environment (defaults are deliberately English):
 *   FILLS='[["input[name=email]","test@example.com"]]'   selectors and values, JSON
 *   SUBMIT='button[type=submit]'                          submit selector
 *   SUCCESS_TEXT='Thank you'                              text that means success
 *   FAILURE_TEXT='error'                                  text that means failure
 *
 * IMPORTANT — this script verifies the *front end* only. A form can render
 * "Thank you" while writing nothing. After this passes, query your datastore for the
 * record you just created, and give that query a positive control. Rule 1 is not
 * satisfied by a green page alone.
 */
import path from 'node:path'

const USAGE = `usage: node walkthrough.mjs <url> [outDir]

Environment:
  FILLS='[["input[name=email]","test@example.com"]]'   selectors and values, JSON (required)
  SUBMIT='button[type=submit]'                          submit selector
  SUCCESS_TEXT='thank you'  FAILURE_TEXT='error'

Requires: npm i playwright && npx playwright install chromium`

const TARGET = process.argv[2]
if (!TARGET || TARGET === '--help' || TARGET === '-h') {
  console.error(USAGE)
  process.exit(TARGET ? 0 : 64)
}

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error('playwright is not installed here. Run: npm i playwright && npx playwright install chromium')
  process.exit(69)
}
const OUT = process.argv[3] || './walkthrough-shots'

const FILLS = JSON.parse(process.env.FILLS || '[]')
const SUBMIT = process.env.SUBMIT || 'button[type="submit"]'
const SUCCESS_TEXT = process.env.SUCCESS_TEXT || 'thank you'
const FAILURE_TEXT = process.env.FAILURE_TEXT || 'error'

if (FILLS.length === 0) {
  console.error('ABORT: FILLS is empty. Set FILLS to the selectors and values for this form,')
  console.error('       e.g. FILLS=\'[["input[type=email]","you@example.com"]]\'')
  console.error('       A run that fills nothing proves nothing.')
  process.exit(2)
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setViewportSize({ width: 1280, height: 900 })

// Console errors and failing responses are the evidence you want when it goes wrong.
const clues = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') clues.push(`[${m.type()}] ${m.text().slice(0, 200)}`)
})
page.on('response', (r) => {
  if (r.status() >= 400) clues.push(`[http ${r.status()}] ${r.url().slice(0, 140)}`)
})

const report = (msg) => console.log(msg)

try {
  report(`-> opening ${TARGET}`)
  // domcontentloaded, not networkidle: any page with polling or analytics never goes
  // idle, and the run dies on timeout before the first screenshot.
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForLoadState('load').catch(() => {})
  await page.screenshot({ path: path.join(OUT, '1-loaded.png'), fullPage: true })

  let filled = 0
  for (const [sel, val] of FILLS) {
    const loc = page.locator(sel).first()
    if ((await loc.count()) === 0) {
      report(`   selector not found: ${sel}`)
      continue
    }
    await loc.fill(String(val))
    filled++
  }

  // Rule 4 applies to this script too: report what happened, not what was attempted.
  if (filled === 0) {
    console.error('ABORT: no FILLS selector matched anything on the page.')
    console.error('       Nothing was typed, so a "submitted" result would be meaningless.')
    await page.screenshot({ path: path.join(OUT, '2-nothing-matched.png'), fullPage: true })
    await browser.close()
    process.exit(2)
  }

  await page.screenshot({ path: path.join(OUT, '2-filled.png'), fullPage: true })
  report(`-> filled ${filled}/${FILLS.length} field(s); open 2-filled.png and confirm the text is actually visible`)

  const submit = page.locator(SUBMIT).first()
  if ((await submit.count()) === 0) {
    console.error(`ABORT: submit selector not found: ${SUBMIT}`)
    await browser.close()
    process.exit(2)
  }
  await submit.click()

  // Wait for an outcome rather than a fixed sleep, but keep a ceiling.
  const body = page.locator('body')
  await Promise.race([
    body.filter({ hasText: new RegExp(SUCCESS_TEXT, 'i') }).waitFor({ timeout: 15000 }),
    body.filter({ hasText: new RegExp(FAILURE_TEXT, 'i') }).waitFor({ timeout: 15000 }),
  ]).catch(() => report('   no success or failure text appeared within 15s'))

  const text = (await page.locator('body').innerText()).toLowerCase()
  const state = {
    filled,
    success: text.includes(SUCCESS_TEXT.toLowerCase()),
    failure: text.includes(FAILURE_TEXT.toLowerCase()),
  }
  await page.screenshot({ path: path.join(OUT, '3-submitted.png'), fullPage: true })

  report(`\nresult: ${JSON.stringify(state)}`)
  if (clues.length) {
    report('\nconsole and network clues:')
    clues.forEach((c) => report('  ' + c))
  }
  report(`\nscreenshots in ${OUT} — look at them before trusting this result.`)
  report('front end only: now query your datastore for the record, with a positive control.')

  await browser.close()
  process.exit(state.success && !state.failure ? 0 : 1)
} catch (err) {
  console.error('walkthrough failed:', err.message)
  await page.screenshot({ path: path.join(OUT, 'error.png'), fullPage: true }).catch(() => {})
  await browser.close()
  process.exit(3)
}
