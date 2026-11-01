---
name: pc-checkin
description: "Check in on recent GitHub activity across tracked repos. Filters to items needing your action (ball-in-court)."
---

# /pc-checkin

Check in on recent activity across tracked repos.
Shows issues, PRs, and comments that need your attention.

## Instructions

Run the check-in to fetch recent GitHub activity:

```bash
pc checkin
```

This will:
1. Read repos from `sources.yml`
2. Fetch issues, PRs, and comments updated since last check-in
3. **Filter to items needing your action** (ball-in-my-court logic)
4. Display activity grouped by repo with GitHub refs (e.g., `matsengrp/repo#123`)
5. Check board sync status

## Ball-in-my-court filtering (default)

By default, checkin only shows items where you need to act:

| Scenario | Shown? | Reason |
|----------|--------|--------|
| Their issue/PR, no comments, you're involved* | Yes | Need to review |
| Their issue/PR, no comments, no involvement | No | Not your responsibility |
| Their issue/PR, they commented last | Yes | They pinged again |
| Their issue/PR, you commented last | No | Waiting for their reply |
| Your issue/PR, no comments | No | Waiting for feedback |
| Your issue/PR, they commented last | Yes | They replied |
| Your issue/PR, you commented last | No | Waiting for their reply |

*"You're involved" means at least one of: you're an assignee, requested reviewer, @mentioned in the body, or have previously commented on the item.

Use `--broad` to restore the older behavior (every teammate item with no window activity counts as needing review).
Use `--all` to disable filtering entirely.

## Options

- `pc checkin --all` — Show all activity (disable ball-in-my-court filtering)
- `pc checkin --broad` — Legacy broad filter (count every teammate item as needing review)
- `pc checkin --since 2d` — Check activity from last 2 days instead of last check-in
- `pc checkin --since 12h` — Check activity from last 12 hours
- `pc checkin --repo matsengrp/dasm2-experiments` — Check single repo
- `pc checkin --category code` — Check only repos in the "code" category
- `pc checkin --summarize` — Add LLM-generated take-home summaries for each item (uses claude CLI)

## Review workflow

After checkin shows activity, route review or implementation requests through `/pc-orchestrator` intake with repository, Issue/PR and evidence pointers.
The owning managed Run assigns persistent work and verifies startup.
