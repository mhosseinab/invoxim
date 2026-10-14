# Native coding-agent adapters

Canonical content lives in `.agents/rules/`, `.agents/skills/` and `.agents/subagents/`. Root `AGENTS.md` sets the common contract. Native adapter files are deliberately thin so the instructions do not drift in three independent copies.

## Codex

`.codex/agents/ledger-*.toml` defines named roles with `name`, `description` and `developer_instructions`; read-only review roles specify a read-only sandbox. `.codex/config.toml` caps concurrently spawned threads at four. Models are not hardcoded: inherit the available parent setup. The current documented standalone role format and `.agents/skills` discovery were checked against official sources. [S33, S34]

Do not overwrite an existing repository or user configuration while merging this package. Merge the relevant settings intentionally. During T00, verify that the installed version recognizes the files and reports the intended role/sandbox/skill. Global or user policy can affect effective behavior. If native role discovery differs, update the thin adapter based on verified documentation, not the canonical product requirements.

## Claude Code

`CLAUDE.md` points to the canonical root instructions. `.claude/agents/ledger-*.md` defines tool-scoped roles and inherits the session model. Read-only reviewers have only Read/Glob/Grep, not a shell disguised as read-only access. Implementation agents can run tests and edit assigned files. The orchestrator definition requests Agent support, but actual nested delegation depends on the installed runtime; use the primary session for delegation when required. [S35]

Each adapter explicitly instructs the agent to read its canonical role and skills. This does not depend on those skills being automatically installed into Claude’s skill registry. Native `.claude/skills/` discovery can be pointed at the canonical `.agents/skills` tree by the coding agent; do not maintain two independent versions or install unreviewed third-party skills.

## OpenCode

`.opencode/agents/ledger-*.md` defines a primary orchestrator plus specialist subagents. Read-only review adapters deny edits and shell execution; implementation roles inherit the owner’s permissions instead of enabling a permissive global policy. OpenCode documents discovery of `.agents/skills`. [S36, S37]

Prefer canonical `.agents/skills` for OpenCode; before mixing adapters in one environment, check the actual loaded skill paths and resolve duplicated managed copies rather than guessing which version wins. No provider/model is hardcoded in these agent files.

## What these files do not guarantee

No native coding tool was launched while preparing this package. TOML/JSON/frontmatter and references can be checked structurally; runtime discovery, effective permission enforcement, role spawning and model availability require T00 smoke tests. A role description alone does not enforce a sandbox. Do not equate thirteen available roles with thirteen agents that must be spawned.

For tools without native subagents, use sequential task handoffs from `START_HERE.md` and the canonical role files. Label review as self-review when no independent agent or person actually performed it. The same agent writing two reports is not independent validation.

The supplied skills are original, project-specific instructions. The Agent Skills specification and Cloudflare’s official skills repository are useful references, not certification of code quality. [S38, S39] Do not blindly install community skill collections or grant them access to real receipts, secrets, production resources or external actions.
