# Blueprint helper tools

Requires Python 3.11 or later for the standard-library TOML parser. These tools do not install the app, create cloud resources, connect accounts, call models, or deploy anything.

From the repository root:

```sh
python3 tools/validate_blueprint.py
```

The validator checks JSON/TOML structure, role/skill references, task dependencies, acceptance links, source IDs, synthetic evidence quotes, and exact numerical fixtures. It imports `tools/validate_presentation.py` to check onboarding copy references and state fixtures, concrete repository document links, synthetic presentation evidence, and paid/refunded/net arithmetic. The presentation fixtures are expected display projections, not the output of an implemented application reducer.

Full JSON Schema validation additionally requires `jsonschema`. Require it instead of accepting a clearly reported skip:

```sh
python3 tools/validate_blueprint.py --require-schema
```

Install `jsonschema` through your Python environment's normal dependency-management process. Do not treat helper validation as an application build, UX benchmark, or live-provider test.

`install_claude_skills.py` is optional. It can copy managed skills into `.claude/skills` for native discovery. Read `.agents/ADAPTERS.md` before using it. Default validation does not perform those copies.

Helper regression checks run against temporary copies of this blueprint:

```sh
python3 tools/test_blueprint_helpers.py
```

The suite has 20 tests. The eight v1.1 additions reject unknown copy, premature no-results display, unlabeled demo data, wrong demo arithmetic, missing evidence, missing concrete document links, invalid Start state, and unexpected secret fields. Existing tests cover task/role/source/acceptance integrity, extraction/financial fixtures, and safe skill copying. The suite requires `jsonschema` because the positive baseline explicitly requests schema validation.
