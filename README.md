English | [繁體中文](./README.zh-TW.md)

# Ultra Lab Agent Skills

Skills distilled from production incidents on systems with real users, at [Ultra Lab](https://ultralab.tw).

Every rule in these skills cost something before it was written down. None of them are theory.

## Installation

```bash
# All skills
npx skills add ppcvote/ultralab-skills

# Specific skill
npx skills add ppcvote/ultralab-skills --skill verification-discipline
```

## Skills

| Skill | What it prevents | Triggers |
|-------|------------------|----------|
| **verification-discipline** | An agent reports success, every check is green, and nothing actually happened | `is this done`, `verify`, `the test passes but`, `nothing happened`, `silently failing`, `before I ship`, `positive control` |

## verification-discipline

The failure mode: your agent says the task is complete. The status endpoint is green. The logs show no errors. And the thing it was supposed to do never happened.

Seven rules, each from a real incident:

1. **Verify along the path the user actually walks.** A form's code was correct at every layer; code review found nothing. A browser walkthrough found that submissions failed for every user, because database rules for a new collection were never added. HTTP 200 everywhere, zero writes.
2. **Every check needs a positive control.** Prove the check can fail before trusting that it passed. Single-page apps return 200 with full HTML for missing routes, and that HTML may contain your search string.
3. **Mark complete only after it is complete.** A job marked questions answered before generating answers. Generation hit a quota error. The questions were permanently marked handled, never retried, and the log said "no new questions."
4. **Count outcomes, not effort.** A counter recorded "content generated" rather than "content published." Broken machines looked busier than healthy ones.
5. **Before changing something shared, find everyone using it.** The expensive bug is not doing something wrong; it is doing something right and severing a downstream consumer.
6. **When a test fails, suspect the test first.** In one session, four of five failing assertions were wrong tests, not wrong code. A false pass is worse than a false failure.
7. **Investigating "why did nothing happen."** A fixed four-step order, because silent failure has no error message to search for.

Bundled runnable scripts:

| Script | Purpose |
|---|---|
| `positive-control.sh` | Verification template that aborts when the check cannot fail |
| `number-guard.mjs` | Blocks generated numbers absent from source data; self-tests on run |
| `heartbeat-check.sh` | Watches watchdogs, including itself |
| `walkthrough.mjs` | Browser walkthrough with screenshots at each step |

Start with `node scripts/number-guard.mjs`. It self-tests six cases and needs no configuration.

## Longer form

These rules are the condensed version. The full write-ups, with complete incident narratives and the structural-enforcement patterns for multi-turn agent work, are in the [Claude Code field manual](https://ultralab.tw/handbook) (Traditional Chinese).

## License

MIT. Use them, fork them, ship them in your own projects.
