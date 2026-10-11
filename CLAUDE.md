# Claude Code repository entry point

Read and follow root `AGENTS.md` and `START_HERE.md` before work. They are the canonical repository instructions. Follow the selected task in `.agents/backlog.json`, load its role and skills, use behavioral TDD and preserve the agreed product scope.

Project-specific subagent definitions live in `.claude/agents/`. Each explicitly tells the agent to read its canonical `.agents/subagents/` role and skills. Canonical skill files are not duplicated automatically. See `.agents/ADAPTERS.md` for the optional skill-copy helper and actual discovery checks.

Do not confuse defining subagents with executing them. Record which independent reviewers actually ran. Do not use unsafe permission-bypass modes or allow real customer secrets/data into prompts.
