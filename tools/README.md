# Blueprint helper tools

Requires Python 3.11 or later for the standard-library TOML parser. These tools do not install the app, create cloud resources, connect accounts, call models, or deploy anything.

From the extracted repository root:

```sh
python3 tools/validate_blueprint.py
```

The validator checks JSON/TOML structure, role/skill references, task dependencies, acceptance links, source IDs, synthetic evidence quotes, and exact numerical fixtures. It imports `tools/validate_presentation.py` to check onboarding copy references and state fixtures, concrete packaged document links, synthetic presentation evidence, and paid/refunded/net arithmetic. The presentation fixtures are expected display projections, not the output of an implemented application reducer.

Full JSON Schema validation additionally requires `jsonschema`. Require it instead of accepting a clearly reported skip:

```sh
python3 tools/validate_blueprint.py --require-schema --output validation-report.json
```

The preparation environment already had `jsonschema`; no network installation was required. Reproduce in your approved Python environment using its normal dependency-management process. Do not treat helper validation as an application build, UX benchmark, or live-provider test.

`install_claude_skills.py` is optional. It can copy managed skills into `.claude/skills` for native discovery. Read `.agents/ADAPTERS.md` before using it. Default validation does not perform those copies.

Helper regression checks run against temporary copies of this blueprint:

```sh
python3 tools/test_blueprint_helpers.py
```

The suite has 20 tests. The eight v1.1 additions reject unknown copy, premature no-results display, unlabeled demo data, wrong demo arithmetic, missing evidence, missing concrete document links, invalid Start state, and unexpected secret fields. Existing tests cover task/role/source/acceptance integrity, extraction/financial fixtures, and safe skill copying. The suite requires `jsonschema` because the positive baseline explicitly requests schema validation.

`evidence/blueprint-helper-tests-red-v1.1.log` is the recorded pre-implementation run: eight expected failures while presentation validation was absent. `evidence/blueprint-helper-tests.log` is the final passing run. These demonstrate the helper change's red/green sequence only; they do not establish behavioral TDD for an application that has not been built.

`tools/check_package_syntax.py` performs the separate JSON/TOML/YAML-frontmatter and Python-AST packaging audit; run it to write `evidence/package-syntax-audit.json`. It requires PyYAML for the frontmatter audit. It does not check agent runtime discovery or effective permissions.
