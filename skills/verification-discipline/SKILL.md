---
name: verification-discipline
version: 1.0.0
description: Verification discipline for agent work that reaches the real world. Load before claiming a task is done, when a check passes more easily than expected, when a scheduled job silently produces nothing, or when a test fails and the code looks right. Enforces positive controls, user-path verification, correct completion-marking order, outcome-based counting, and downstream impact checks. Use whenever the work will be published, deployed, or emailed, or will otherwise change state outside this session.
---

# Verification Discipline

The failure mode this skill prevents: **an agent reports success, every check is green, and nothing actually happened.**

These rules come from production incidents on systems with real users. Each one cost something before it was written down.

## When to load this

- Before saying a task is complete, when the work touched anything outside this session
- When a check passed and you did not expect it to
- When something scheduled produced nothing, but the service looks healthy
- When a test fails and the code looks correct
- Before changing a shared field, endpoint, or data shape

## Rule 1: Verify along the path the user actually walks

An internal check passing does not mean the feature works. Test paths and user paths diverge, and the divergence is where bugs live.

- Web feature: open a real browser, click through, **screenshot it**
- API: call it from outside, with the same auth a caller would use
- CLI: run it in a clean directory or container

**A real case**: a form's code was correct at every layer. Code review found nothing. A browser walkthrough found that submissions failed for every user, because the database rules for a new collection were never added. HTTP 200 everywhere; zero writes.

Screenshots catch a different class of failure than status codes do. White text on a white background is valid CSS on every line; only a picture shows it.

## Rule 2: Every check needs a positive control

Before trusting that a check passed, prove it can fail. Feed it something you know is broken. If it still passes, the check is worthless and so is the result.

```bash
# Positive control: this MUST fail, or the check itself is broken
if check "https://example.com/definitely-not-real-$RANDOM"; then
  echo "ABORT: the check passes on a target that does not exist."
  exit 2
fi
# Only now does a pass mean anything
check "https://example.com/real-page" && echo PASS
```

Common reasons a check silently always passes:

- Single-page apps return HTTP 200 with full HTML for missing routes, and that HTML may contain your search string
- The parsing tool is not installed, and its error goes somewhere nobody reads
- The command writes errors to stdout, so the condition is always true
- A "stash and test" step is a no-op because the tree was already clean

`scripts/positive-control.sh` is a ready-to-use template.

## Rule 3: Mark complete only after it is complete

Marking something handled before doing it turns any failure into permanent silent data loss.

```javascript
// Wrong: this line consumes the item even if the next line throws
state.handled.push(id)
const result = await generate(item)
await publish(result)

// Right: anything left unmarked is picked up again on the next pass
const result = await generate(item)
const res = await publish(result)
if (!res.ok) throw new Error(`publish failed ${res.status}`)
state.handled.push(id)
```

**A real case**: a question-answering job marked questions answered before generating the answer. When generation hit a quota error, the questions were permanently marked handled and never retried. The log said "no new questions." Real user questions vanished while every log line said the system was healthy.

## Rule 4: Count outcomes, not effort

Put the counter where the outside world actually changed, not where your work finished.

```javascript
// Wrong: counts your own activity
const content = await generate()
metrics.posted++

// Right: counts what actually landed, and counts failures separately
const res = await platform.publish(content)
if (res.ok && res.postId) metrics.published++
else metrics.failed++
```

Corollary: **absence of a report is not a report of zero.** A dashboard zero means either "nothing happened" or "the reporting path is broken." Render those differently, or a dead system will look idle.

```javascript
if (Date.now() - lastHeartbeat > TWO_HOURS) render('UNKNOWN (no report for 2h)')
else render(`${count} items`)
```

## Rule 5: Before changing something shared, find every consumer of it

The expensive bug is not doing something wrong. It is doing something right and severing a downstream consumer.

```bash
rg -n "oldFieldName" --type-not lock     # who reads this field
rg -n "/api/the-endpoint" -g '!node_modules'  # who calls this
```

Then verify the paths you found, not only the one you changed.

## Rule 6: When a test fails, suspect the test first

In one debugging session on a production system, four of five failing assertions turned out to be wrong tests rather than wrong code.

The four recurring causes:

1. **Expectations written from memory, not from real data.** Read one real record and print every field before writing an assertion. The stored format is rarely what you pictured.
2. **A substring match that hits the wrong document.** The query matched articles that merely quoted the identifier, so it returned none of the actual records while the assertion still went green. This false pass is worse than a false failure: a false failure wastes your time; a false pass ships a real defect with a green light.
3. **A regex broken by punctuation in the middle.** The test expected `Law Article 112`; the model wrote `"Law" Article 112`. Allow punctuation between the parts.
4. **Zero matches counting as success.** "All identifiers are valid" is vacuously true when the regex matched nothing.

```javascript
const found = output.match(pattern) || []
if (found.length === 0) throw new Error('Assertion unverifiable: matched nothing')
```

Never loosen a check just to make it go green. Ask: **if the feature were actually broken, would this check still be red?** If not, you deleted the test rather than fixing it.

## Rule 7: Investigate "why did nothing happen" in a fixed order

Silent failure has no error message. Work through these in order, or you will guess for hours:

1. **Read the decision code and enumerate every early exit.** Every `return`, `continue`, and guard clause is a place where nothing happens quietly. Most answers appear here.
2. **Query the outcome, not the status.** Not "is it running" but "what did it produce, and when was the last one."
3. **Check every layer.** Trigger, execution, write, notification. A job can be perfectly healthy and still die at the last hop.
4. **"Not found" is not the same as "did not happen."** Confirm your query would find the thing if it existed. That is a positive control again.

The five ways a healthy-looking service lies:

- Auth expired; the process loops on rejected requests forever
- The scheduled trigger never fired, but service status reads fine
- The monitor itself died, so alerts stopped
- Deduplication misfired and skipped real work
- Output quality collapsed to a constant: the volume looks normal, the content is useless

A silent skip usually needs two fixes: restore whatever was exhausted, **and make the skip raise an alert instead of logging "nothing to do."**

## Before you say it is done

- [ ] I walked the path a user walks, and kept a screenshot if there is a UI
- [ ] My check has a positive control proving it can fail
- [ ] Completion is marked only after the external effect succeeded
- [ ] I count outcomes, and unknown is not rendered as zero
- [ ] I searched for downstream consumers and verified them too
- [ ] If a test failed, I checked the test before changing the code

## Bundled scripts

| Script | Purpose | Needs |
|---|---|---|
| `scripts/number-guard.mjs` | Blocks generated numbers absent from source data | node |
| `scripts/positive-control.sh` | Verification template that aborts when the check cannot fail | bash, curl |
| `scripts/heartbeat-check.sh` | Watches watchdogs; pair with an external dead-man's switch to cover its own death | bash, curl |
| `scripts/walkthrough.mjs` | Browser walkthrough with screenshots at each step | `npm i playwright` |

Run `node scripts/number-guard.mjs` first. It self-tests 14 cases across English and
Chinese input, needs no configuration, and exits non-zero if any case misbehaves.

Two limits worth knowing before you wire these in:

- **`heartbeat-check.sh` cannot detect its own death on the same host.** If it stops
  being scheduled, nothing notices. Set `PING_URL` to an external dead-man's switch
  (healthchecks.io, Cronitor, or a second machine) to close that gap.
- **`walkthrough.mjs` verifies the front end only.** A form can render "Thank you"
  while writing nothing, which is exactly the incident in Rule 1. After it passes,
  query your datastore for the record, and give that query a positive control.

---

Distilled from production incidents at [Ultra Lab](https://ultralab.tw). The long-form version, with full incident write-ups and the structural-enforcement patterns for multi-turn agent work, is at <https://ultralab.tw/handbook>.
