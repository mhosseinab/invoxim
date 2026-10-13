# Standard issue labels

Recreate with `scripts/setup-labels.sh`. Colors are GitHub 6-digit hex without `#` in the `gh` CLI.

## Always-present GitHub defaults (do not recreate)

| Name | Color | Purpose |
|------|-------|---------|
| `bug` | `d73a4a` | Something isn't working |
| `documentation` | `0075ca` | Improvements or additions to documentation |
| `enhancement` | `a2eeef` | New feature or request |
| `duplicate` | `cfd3d7` | This issue or pull request already exists |
| `invalid` | `e4e669` | This doesn't seem right |
| `wontfix` | `ffffff` | This will not be worked on |
| `question` | `d876e3` | Further information is requested |
| `help wanted` | `008672` | Extra attention is needed |
| `good first issue` | `7057ff` | Good for newcomers |
| `accessibility` | `f143ab` | Barrier affecting people with disabilities |

Prefer `category:a11y` for our taxonomy; keep `accessibility` for upstream-compatible filtering.

## Priority labels (create these)

| Name | Color | Description |
|------|-------|-------------|
| `priority:high` | `B60205` | Must fix before task close |
| `priority:medium` | `D93F0B` | Real defect or contract gap |
| `priority:low` | `FBCA04` | Hardening or polish |

## Category labels (create these)

| Name | Color | Description |
|------|-------|-------------|
| `category:security` | `0E8A16` | Security / injection / authz |
| `category:money` | `1D76DB` | Financial correctness |
| `category:data-integrity` | `5319E7` | Schema / durability / identity |
| `category:api-contract` | `0052CC` | Contract or schema drift |
| `category:correctness` | `0052CC` | Behavioral bug |
| `category:race` | `0052CC` | Concurrency / CAS / double-apply |
| `category:test-gap` | `FBEC7D` | Missing or misleading tests |
| `category:ops` | `C2E0C6` | CI, cleanup, operational |
| `category:privacy` | `7A0099` | Deletion / retention / secrets |
| `category:privacy-secrets` | `7A0099` | Alias-style name for redaction/secret exposure |
| `category:ux-truthfulness` | `E99695` | Copy vs capability honesty |
| `category:a11y` | `F9D0C4` | Accessibility |
| `category:resource-limits` | `E4E669` | Quotas, bounds, resource use |

## Label combinations

| Kind of finding | Labels |
|-----------------|--------|
| Security P1 | `bug,priority:high,category:security` |
| Money correctness P1 | `bug,priority:high,category:money` |
| Schema/durability P2 | `bug,priority:medium,category:data-integrity` |
| Contract drift P1 | `bug,priority:high,category:api-contract` |
| Missing test P2 | `bug,priority:medium,category:test-gap` |
| Doc-only | `documentation,priority:low,category:ops` (or omit `bug`) |
| Hardening batch | `bug,priority:low,category:correctness,category:test-gap,category:ops` |

One primary category in the title bracket; extra categories still go on the `--label` list.
