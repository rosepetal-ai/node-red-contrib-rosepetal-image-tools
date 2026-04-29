---
name: document-all-nodes
description: |
  Find every node in @rosepetal/node-red-contrib-image-tools that lacks
  documentation (no docs/<cat>/<name>.md or no assets/nodes/<cat>/<name>-demo.gif)
  and run /document-node on each, sequentially. Reports a final table of
  successes and failures. Pass --include-existing to re-document every
  registered node, regardless of current state.
when_to_use: |
  Trigger phrases: "document all nodes", "document missing nodes", "fill in
  the missing docs", "regenerate all node docs". No required arguments.
argument-hint: "[--include-existing]"
allowed-tools: Read Bash Skill
disable-model-invocation: false
---

# /document-all-nodes

Batch wrapper that runs `/document-node` for every orphan node in this repo.

## Procedure

1. **Discover orphans.** Read `package.json` and list `rp-*` keys under `node-red.nodes`. For each, derive the bare name and category (from the JS path). A node is an "orphan" when **either** `docs/nodes/<cat>/<name>.md` is missing **or** `assets/nodes/<cat>/<name>-demo.gif` is missing. Use `Bash` to run `find` / `test -f` rather than reading directories manually.

   With `--include-existing`, treat every registered node as orphan.

2. **Print a plan.** Show the user the list you'll process, in order. Sort by category, then alphabetically.

3. **Process sequentially.** For each orphan, invoke `/document-node <name>` via the `Skill` tool and wait for the result before moving on. Why sequentially: the GIF recorder needs exclusive access to the headless browser page; running concurrent doc runs would race on Node-RED state.

4. **Per-node bookkeeping.** Track success/failure for each. On failure, capture the failure reason but **continue** with the next node — don't abort the whole batch.

5. **Final summary.** Print a Markdown table:

   | Node | Category | .md | GIF | Status |
   |---|---|---|---|---|
   | folder-in | io | ✅ written | ✅ 312 KB | OK |
   | add-bbs | blend | ✅ written | ❌ failed (size) | Reviewer flagged |
   | … | … | … | … | … |

   Then a one-line totals row: "X/Y nodes documented end-to-end. Z need manual review."

## Hard rules

1. **No parallelism.** Sequential only.
2. **Don't skip Phase 0** for each `/document-node` run — the validator is idempotent and cheap; let it confirm the environment didn't drift mid-batch.
3. **Don't keep going if Phase 0 fails for any node** — that's an environment problem affecting the whole batch. Stop and surface the validator's note immediately.
4. **English only** in the final report and any per-node messages.
