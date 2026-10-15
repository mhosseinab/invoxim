# Tools

Project tooling lives in [`implementation/`](implementation/README.md): package-boundary checks (`check-boundaries.mjs`, wired as `pnpm check:boundaries`), secret and dependency security gates (`security-gates.mjs`), production-artifact checks (`production-artifacts.mjs`), the Clef evaluation runner (`clef-eval.mjs`, wired as `pnpm test:eval:clef`), and Node test suites for these tools plus documentation checks (documented `pnpm` scripts and `docs/`/`evidence/` paths). The tool tests run first in `pnpm test:unit`.
