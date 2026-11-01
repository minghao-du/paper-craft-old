---
name: pc-continue
description: Resume from the continuation prompt a tuckin left — pick the role-keyed _ignore/CONTINUE-<role>.md, report its staleness, run each in-flight item's inline check before acting, and hand off to the cold-start skill it names. Run in a fresh session after /clear; pairs with /pc-tuckin.
allowed-tools: Skill, Bash, Read
---

# /pc-continue

Pick up where the last session's `/pc-tuckin` left off, from the role-keyed prompt it wrote ([the continuation contract](../lib/continuation.md)).

## Steps

1. **Determine the role** from the explicit assignment or task markers; for managed workflow roles, verify Dispatch/Attempt identity against the owning Run before proceeding.
   Read `_ignore/CONTINUE-<role>.md` — for an epic, `_ignore/CONTINUE-epic-<N>.md`, keyed by EPIC number. For landing, read `CONTINUE-landing-<PR>.md` at the absolute path supplied by the orchestrator; reconcile its assignment before using the checkout.
   If several `CONTINUE-*.md` exist and the role or EPIC is unknown, list them and ask.
   If none exists, say so and stop; if a marker file makes the type obvious, offer the matching cold-start instead (`/pc-ms`, `/pc-orchestrator`, or `/pc-epic`).
2. **Report staleness**: the file's written-at stamp against `git log -1` and the newest PR/issue activity. If the world moved since it was written, the checks below matter more.
3. **Reconcile lifecycle state** through [Lifecycle recovery](../pc-orchestrator/managed-lifecycle.md) for orchestrator, EPIC and assigned worker/landing roles before dispatch or edits. A resumed conversation does not acquire a released checkout.

   **Follow the prompt**: `cd` where it says, invoke the named skill or read its text, and read the durable state it points at.
   Take that skill's orientation but not its "stop and ask what next": the file's in-flight items are the user's direction, written before the `/clear`.
4. **Before acting on any in-flight item, run its inline `FIRST CHECK`.** Treat every present-tense claim and every number in the file as stale until a command re-derives it; live task records supersede its task status. For scientific judgments, read the fixed Project research entry and relevant evidence; a continuation or EPIC summary does not override them. Drop what the checks retire.
5. **Carry forward anything pending with the user.** Then state where things stand in a sentence or two, and continue with the in-flight items. Stop only for what is pending with the user, or where a check contradicts the file.

Leave `_ignore/CONTINUE-<role>.md` in place; the next `/pc-tuckin` overwrites it.
