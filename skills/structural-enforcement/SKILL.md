---
name: structural-enforcement
version: 1.0.0
description: Structural enforcement for obligations a prompt cannot guarantee. Load when the model keeps announcing work instead of doing it, when it keeps stopping midway through a multi-step task, when an "always do X" instruction fails despite rewrites, when you are about to force a model to continue, when designing safety valves around forced continuation, or when a forcing loop threatens to run away. Covers the prohibition/obligation boundary, the four safety valves, the precondition rule that prevents forced hallucination, and the Claude Code Stop-hook mapping.
---

# Structural Enforcement

The failure mode this skill prevents: **you need the model to always finish something, you write the rule into the prompt, and the model still stops halfway, sounding perfectly natural while it does.**

These patterns come from a month of repeated failures on a live production system with paying customers. None of them are in any vendor's documentation.

## When to load this

- The model keeps announcing work instead of doing it ("let me check and get back to you")
- An "always do X" prompt rule has been rewritten more than once and still fails
- You are about to inject a message that forces the model to continue
- You are wiring a Stop hook or any forced-continuation mechanism
- A forcing mechanism exists and you need to know what can go wrong with it

## The boundary: prohibitions hold at the prompt layer, obligations do not

**Telling a model *not* to do something works in the prompt. Telling it to *always finish* something does not.**

From production, side by side:

| Requirement | Prompt result |
|---|---|
| Don't invent customer data | One rule fixed it |
| Don't use hype language | One rule fixed it |
| After comparing the data, finish the check | **Three prompt rewrites, still stopped halfway** |
| Always append the disclaimer | Explicit rule, still skipped |

The third row is the evidence. Three rewrites did nothing; a state flag that blocks the wrap-up and injects a forcing message worked the first time.

Why: a prohibition is a single-point decision the model makes within a single turn, and it rereads the rule every turn. Completion is an obligation spanning turns. If any one turn resolves to "report progress first," the chain breaks, and the break reads as a completely normal sentence. Meanwhile the server already knows the truth: whether the tool ran, whether the file exists. Decide on that evidence, not on the prompt.

One line to remember: **the prompt sets the probability, the control flow sets the guarantee.** Keep the prompt rule; it raises the first-try success rate. Just never let it be the only layer.

### Detecting a stall

These phrases, paired with a promised action that never happened, are the signal to force:

```
one moment / please hold / working on that now
let me check and get back to you / next, you can
```

## The four safety valves

Once you force, you need all four. Shipping with two of them missing cost real money.

```javascript
// SKELETON: the forcing branch inside your own multi-turn loop.
// Wire in your model call, tools, and state table; the valve conditions are the point.
let forced = 0;
for (let round = 0; round < MAX_ROUNDS; round++) {
  if (spent > TOKEN_BUDGET) { status = 'budget_exhausted'; break; }  // breakers at the top

  const res = await callModel(messages);
  spent += res.usage.total;

  if (res.toolCalls?.length) {
    // Run tools; write what ACTUALLY happened into `state` (rows returned, path written).
    continue;
  }

  // Model thinks it is done. Decide from server-side facts, never from its prose.
  if (
    forced < 1 &&                       // Valve 1: force at most once
    round < MAX_ROUNDS - 2 &&           // Valve 2: leave a round to wrap up
    state.dataFound && !state.saved     // Valve 3: precondition from real tool records
  ) {
    forced++;
    messages.push({ role: 'user', content:
      '[system override, not the user speaking] The data is in the previous tool result. ' +
      'Complete the task and output the result now. Do not report progress.' });
    continue;                           // Valve 4: back to the top, normal metering and breakers
  }

  status = state.saved ? 'done' : 'gate_blocked';
  break;
}
```

**Valve 1, force at most once.** A model that will not comply after one forced round gives you an infinite loop and a burned budget. The ceiling is a counter in code, not a sentence in the prompt.

**Valve 2, leave at least one round to wrap up.** Forcing on the last round means the model never gets to state the result; the user sees a truncated sentence. Two rounds is the usual reserve: one to do the work, one to report it.

**Valve 3, check the precondition.** In the original incident the query came back empty, there was nothing to check, and the forcing logic still pushed the model to "complete the check." So it invented one. **Forcing without a precondition check manufactures hallucinations.** No data means no forcing; handle the empty case in code (write the empty report yourself, or ask the user for the missing input).

**Valve 4, `continue` back into the normal loop.** The shortcut people take is calling the model inside the forcing branch. That call never counts against the budget, which leaves the circuit breaker purely decorative. Forcing only queues a message; it does not jump the queue.

Surface `forced` in the return value or the log. A count jumping from 3/day to 150/day means the prompt or the model regressed and the valves are covering for it. The point of a valve is that a break does not quietly register as success.

## The recursion trap

Valve 3's evidence source has one hard rule: **never use the model's own claim as the precondition.** The only reliable evidence of "did it actually do the thing" is the real tool-call record. A model writing "I have run the tests" without running them is precisely the bug you are guarding against; using that sentence as your gate means gating the correction mechanism on the very signal it was built to correct. Read the state table that tools and server code wrote, or the transcript's `tool_use` records. Not one word of model prose gets in.

The same trap applies to trigger detection: do not ask the model whether it needs to look something up. The model that breaks the chain is the same model. Use a regex, a classifier, or server state.

## Related: obligations that force fabrication

"Describe the trend from the data" plus "do not invent data" contradict each other whenever the data is missing; inventing numbers is the only way to satisfy both. The fix ladder, weakest to strongest: permit "I don't know" explicitly; feed the real numbers into context; check the output in code (a regex that matches every number in the output and rejects any absent from the source, normalizing both sides and covering magnitude words like "million"). Only the code layer holds. After installing it, feed it a known-fabricated number and confirm it blocks; a guard that cannot fail proves nothing.

## No backend of your own: the Claude Code mapping

If you only use Claude Code, the **Stop hook** maps onto this exactly. When the model tries to wrap up, the hook runs first; exit code 2 blocks the stop and the text on stderr is fed back to the model, which continues with that instruction. Both behaviors are documented, and so is the loop-prevention signal: the Stop hook's input carries `stop_hook_active: true` when the model is already continuing because a stop hook blocked it; allowing the stop in that case is the documented way to avoid an infinite loop. Rely on documented fields and nothing else; do not invent ones the documentation does not promise. The bundled hook checks `stop_hook_active` first and keeps its own marker file as a second layer.

| Valve | Own loop | Claude Code Stop hook |
|---|---|---|
| 1. Force once | `forced < 1` | Documented `stop_hook_active` input flag: true means a stop hook already blocked, so allow; a marker file keyed by session is the second layer |
| 2. Room to wrap up | `round < MAX_ROUNDS - 2` | Falls out of valve 1: after the forced round, the next stop always passes |
| 3. Precondition | Server-side state table | Parse `transcript_path`, count real `tool_use` records; never read the model's claims |
| 4. Normal loop | `continue` to the top | Exit 2 + stderr is the documented path; the forced round asks permissions and counts budget like any other |

**Fail-open principle**: when in doubt, allow the stop. In your own loop a failed enforcement costs one missed task. A Stop hook that blocks wrongly traps the user in a conversation that cannot end, which costs far more. Unparseable stdin allows; unreadable transcript allows; the marker write happens **before** the block (reverse the order and a failed write becomes an infinite loop). This hook prefers to miss.

The bundled `hooks/must-finish-guard.py` is the tested implementation. Default rule: if this turn edited a code file, a test-run record must exist before wrap-up. Edit the `REQUIRED` list at the top to encode your own obligations. Install it at `<project>/.claude/hooks/` and register it under `hooks.Stop` in settings.

After installing, run all three controls:

1. It blocks what it should (edit a code file, say "done" without tests: must be blocked once)
2. It never blocks twice (wrap up again, tests run or not: must pass)
3. It allows what it should (a question that edits nothing: must pass)

Verify only the first, and what you have installed may be a trap.

## Checklist before shipping a forcing mechanism

- [ ] The obligation is enforced in control flow; the prompt rule is kept but not trusted
- [ ] Force-at-most-once counter exists, in code
- [ ] At least one round is reserved after forcing for the wrap-up
- [ ] The precondition reads tool records or server state, never model prose
- [ ] The empty-precondition case has its own non-forcing path (no data, no force)
- [ ] The forcing branch `continue`s into the normal loop; no side-channel model call
- [ ] Hooks fail open, and the marker is written before the block
- [ ] The forcing count is observable and compared over time
- [ ] All three positive controls ran: blocks, never blocks twice, allows

## Bundled files

| File | Purpose | Needs |
|---|---|---|
| `hooks/must-finish-guard.py` | Tested Claude Code Stop hook implementing all four valves | python3, Claude Code |

---

Distilled from production incidents at [Ultra Lab](https://ultralab.tw). The long-form version, with four fully worked scenarios (daily report, quoting agent, streaming Q&A, nightly batch) and complete runnable code for each, is at <https://ultralab.tw/en/handbook>.
