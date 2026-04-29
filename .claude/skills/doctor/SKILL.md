---
name: doctor
description: |
  Run the documentation environment validator standalone. Probes Node-RED,
  the toolkit install in ~/.node-red, the native addon, sharp, ffmpeg, the
  required MCP servers, fixture images, and filesystem permissions. Self-heals
  whatever can be fixed automatically; reports a structured JSON status.
  Use before a /document-node run if anything in the environment changed,
  or to debug why a doc run failed.
when_to_use: |
  Trigger phrases: "doctor", "doc env check", "is the doc system ready", "check
  the documentation environment", "run the validator". No arguments.
argument-hint: ""
allowed-tools: Agent
disable-model-invocation: false
---

# Doctor

Standalone wrapper that runs the `doc-env-validator` subagent and surfaces its report.

## What you do

1. Spawn the validator subagent in the foreground with this prompt:

   > Run the full environment validation playbook described in your system prompt. Self-heal everything you can. Return your standard JSON contract object as the last line of your response.

2. When it returns:
   - If `ok: true` → reply with a one-line green summary like "Environment ready (healed: <count>, warnings: <count>)".
   - If `ok: false` → echo the validator's `note` verbatim as the actionable instruction for the user, plus the `blockers` list. Do not retry; the user must act.
3. Do not generate any documentation. This skill is read/heal only.

## Constraints

- Single-shot — one validator invocation, no loop.
- No editing of source code.
- No documentation generation. If the user wanted that, they'd have called `/document-node`.
