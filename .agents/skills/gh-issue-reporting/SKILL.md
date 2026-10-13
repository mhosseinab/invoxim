---
name: gh-issue-reporting
description: "File prioritized, categorized GitHub issues with `gh` using the project issue blueprint. Use when reporting bugs or review findings to GitHub, creating issues from code review, QA, or standalone task audits, or when a user says 'file an issue', 'create a GitHub issue', 'report this bug', 'open issues for the findings', or asks to prioritize and categorize defects. Do not use for pull requests, commit messages, or writing code fixes."
---

# GitHub issue reporting

File every defect as a GitHub issue with `gh` using this exact label set, priority model, title format, and body template. The goal is a uniform, scannable issue tracker that any agent or human can triage without re-reading the review.

## When to use

- After a code review, QA pass, security audit, or standalone task review finds bugs.
- When a user asks to "file", "open", or "create" GitHub issues for findings.
- When converting a prioritized bug inventory into tracker items.

Do **not** use this skill to write code, open PRs, or close issues. Review roles do not fix their own findings.

## Preconditions

1. Confirm `gh` is authenticated: `gh auth status`.
2. Confirm the repo remote (issues land on `origin`).
3. Create the standard labels once per repo (idempotent). Run the setup script in `scripts/setup-labels.sh`, or the `gh label create` commands in `references/labels.md`.
4. Collect findings **before** filing. Prefer one issue per coherent finding cluster, not one issue per line.

## Priority model

| Priority | Label | Meaning | Issue title prefix |
|----------|-------|---------|--------------------|
| P1 | `priority:high` | Must fix before the related task/milestone can be treated as closed. Security breaks, money corruption, tenant isolation, contract gates, permanent data loss. | `[P1]` |
| P2 | `priority:medium` | Real defect or contract gap. Incorrect behavior, missing required test, privacy cleanup hole, misleading UX that is still fail-closed. | `[P2]` |
| P3 | `priority:low` | Hardening, polish, doc drift, optional test gap. Fix opportunistically. Batch related P3s into one issue when they share a theme. | `[P3]` |

Never invent a P0 that was not observed. If a review found no P0, say so in the summary and still file the P1s.

## Categories

Apply one or more category labels. Prefer the primary category first.

| Label | Use for |
|-------|---------|
| `category:security` | Injection, authz bypass, SSRF, XSS, secret exposure, boundary enforcement |
| `category:money` | Wrong totals, currency/FX, paid/refunded/net, eligibility, metering |
| `category:data-integrity` | Schema constraints, leases/fences, durability, identity uniqueness, orphans |
| `category:api-contract` | JSON Schema ↔ Zod drift, documented vs live DTOs, export shapes |
| `category:correctness` | Behavioral bugs, control-flow holes, wrong state transitions |
| `category:race` | Concurrency, CAS, lost updates, double-apply |
| `category:privacy-secrets` | Deletion completeness, retention, residual ciphertext, redaction |
| `category:test-gap` | Missing or misleading tests, non-reproducible evidence |
| `category:ops` | CI gates, cleanup, config footguns, operational claims |
| `category:ux-truthfulness` | Copy vs actual capability, overstated claims, wrong user messaging |
| `category:a11y` | Accessibility contract violations |
| `category:resource-limits` | Quotas, bounds, unbounded growth, stalls |

Also apply `bug` (or `documentation` for pure doc issues).

## Title format

```
[<P#>][<primary-category>] <one-line summary in plain English>
```

If there is no single primary category, omit the bracketed category:

```
[<P#>] <summary>
```

Examples:

- `[P1][security] CSV formula injection via Unicode format/fullwidth prefixes in spreadsheetText`
- `[P2] HTML extraction keeps non-visible bait amounts; empty extract can report ready`
- `[P3] Hardening batch from standalone task reviews`

Capitals: sentence-style after the brackets. No trailing period. No issue number in the title.

## Issue body template

Use this structure exactly. Markdown headings keep the tracker scannable.

```markdown
## Summary
One short paragraph: what is broken and why it matters.

## Task(s)
- T## (task title)
- T## (if the finding spans tasks)

## Finding
- **Severity:** P#
- **Category:** category-name
- **File:** `path/to/file.ts:LINE` (and ranges when useful)

### Observed
What the code actually does. Cite the real expression/SQL/logic. Include a confirmed repro when you have one.

### Expected
What the contract, doc, or invariant requires.

### Impact
User/tenant/financial/operational impact. Be concrete ("net spending can flip sign", not "could be bad").

### Suggested fix (not applied)
Smallest correct fix. **Never implement it in a review/report pass** unless the user explicitly asks for fixes.

### Regression test
The named test that would lock the behavior (file + case name or fixture idea).

## Decision from review
request-changes | approve | blocked
```

### Multi-finding clusters

When one issue covers several related findings, keep `## Summary` and `## Task(s)`, then replace the single `## Finding` block with `## Findings` and a numbered `### 1. Title (P#)` per item. Close with a single `## Suggested fixes (not applied)` and `## Regression tests` list.

### Batch issues

For many small P3s that share a theme, one issue titled `Hardening batch…` is allowed. List every item with task ID, one-line description, and `file:line`. Do not use batch issues for P1/P2.

## `gh` commands

Create labels first (idempotent):

```bash
bash .agents/skills/gh-issue-reporting/scripts/setup-labels.sh
```

Create one issue:

```bash
gh issue create \
  --title '[P1][security] <summary>' \
  --label 'bug,priority:high,category:security' \
  --body "$(cat <<'BODY'
## Summary
...
BODY
)"
```

Rules:

- Always quote the heredoc (`<<'BODY'`) so shell expansion cannot corrupt the body.
- Comma-separate multiple `--label` values.
- If `gh` rejects a label as unknown, create the label first, then retry the issue. Do not drop labels silently.
- Confirm creation by listing the issue back; record the issue URL for the completion report.

List by priority (for triage summaries):

```bash
gh issue list --label 'priority:high' --limit 50
gh issue list --label 'priority:medium' --limit 50
gh issue list --label 'priority:low' --limit 50
```

## Deduping and cross-cutting themes

Before filing, group findings across reviews:

1. Same root cause in two tasks → **one** issue, list both tasks (e.g. a schema hole found in T04 and confirmed in T07).
2. Same function, two symptoms → one issue with two findings, or two issues if fixes are independent.
3. Do not file an issue for something the code already mitigates in another layer; mention the mitigation in Observed and lower the severity if appropriate.

## Style rules

- Write for a cold reader who has not seen the review chat.
- Cite `file:line` for every finding. Paths are repo-relative.
- Use fenced code for SQL/JS repros.
- ASCII only in issue bodies unless quoting a Unicode attack character (then also show the escape, e.g. `\u200B`).
- Do not paste secrets, tokens, or real user data. Synthetic fixtures only.
- Do not assign people or milestones unless the user asked.
- Do not close, comment on, or edit existing issues unless asked.
- Reviewers never implement fixes in the same pass that files the issue.

## Example

User: "File issues for the review findings."

1. Group findings into clusters; assign P1/P2/P3 and categories.
2. Ensure labels exist (`setup-labels.sh`).
3. Create each issue with `gh issue create` using the template.
4. Report a short table of issue numbers and titles, plus priority counts.

## Quality gate

- Every issue has severity, category labels, `file:line`, expected vs observed, and a regression-test pointer.
- No P1/P2 hidden in a batch issue.
- No code changes in the reporting pass unless explicitly requested.
- Issue count matches the number of filed `gh create` successes (verify with `gh issue list`).

## Related

- Findings format: `.agents/templates/review-report.md`
- Review procedure: `.agents/skills/code-review-and-release/SKILL.md`
- Label inventory and colors: `references/labels.md`
