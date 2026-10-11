#!/usr/bin/env python3
"""Tests for blueprint helper scripts only. These are not application tests."""
from __future__ import annotations
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]

class BlueprintHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix='blueprint-helper-test-')
        self.root = Path(self.temp.name) / 'repo'
        shutil.copytree(SOURCE, self.root, ignore=shutil.ignore_patterns('__pycache__'))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_tool(self, tool: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(self.root/'tools'/tool), *args],
                              cwd=self.root, text=True, capture_output=True, timeout=20)

    def alter_json(self, path: str, change) -> None:
        p = self.root/path
        document = json.loads(p.read_text())
        change(document)
        p.write_text(json.dumps(document))

    def test_validator_accepts_package(self) -> None:
        result = self.run_tool('validate_blueprint.py', '--require-schema')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'passed')

    def test_validator_rejects_task_cycle(self) -> None:
        self.alter_json('.agents/backlog.json', lambda x: x['tasks'][0]['dependsOn'].append('T26'))
        result = self.run_tool('validate_blueprint.py')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cycle', result.stderr)

    def test_validator_rejects_unknown_role(self) -> None:
        self.alter_json('.agents/backlog.json', lambda x: x['tasks'][0].update(ownerRole='invented-role'))
        self.assertNotEqual(self.run_tool('validate_blueprint.py').returncode, 0)

    def test_validator_rejects_unknown_acceptance_case(self) -> None:
        self.alter_json('.agents/backlog.json', lambda x: x['tasks'][0]['acceptanceCaseIds'].append('NOT-A-CASE'))
        self.assertNotEqual(self.run_tool('validate_blueprint.py').returncode, 0)

    def test_validator_rejects_missing_skill(self) -> None:
        (self.root/'.agents/skills/ai-extraction-and-evals/SKILL.md').unlink()
        self.assertNotEqual(self.run_tool('validate_blueprint.py').returncode, 0)

    def test_validator_rejects_unmatched_evidence(self) -> None:
        self.alter_json('test-design/fixtures/receipts.json', lambda x: x['fixtures'][0]['expectedExtraction']['records'][0]['evidence'][0].update(quote='not present anywhere'))
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_validator_rejects_incorrect_money_oracle(self) -> None:
        self.alter_json('test-design/financial-cases.json', lambda x: x['cases'][0]['expected'].update(minor='999'))
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_helper_dry_run_writes_no_skill_files(self) -> None:
        result = self.run_tool('install_claude_skills.py', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root/'.claude/skills').exists())
        self.assertFalse((self.root/'.claude/.managed-skill-copies.json').exists())

    def test_helper_copy_is_idempotent(self) -> None:
        for _ in range(2):
            result = self.run_tool('install_claude_skills.py')
            self.assertEqual(result.returncode, 0, result.stderr)
        for p in (self.root/'.agents/skills').glob('*/SKILL.md'):
            self.assertEqual(p.read_bytes(), (self.root/'.claude/skills'/p.parent.name/'SKILL.md').read_bytes())

    def test_helper_refuses_modified_managed_copy(self) -> None:
        self.assertEqual(self.run_tool('install_claude_skills.py').returncode, 0)
        p = self.root/'.claude/skills/ai-extraction-and-evals/SKILL.md'
        p.write_text('Owner changes must survive.')
        result = self.run_tool('install_claude_skills.py')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(p.read_text(), 'Owner changes must survive.')

    def test_helper_refuses_unmanaged_conflict(self) -> None:
        p = self.root/'.claude/skills/ai-extraction-and-evals/SKILL.md'
        p.parent.mkdir(parents=True)
        p.write_text('Existing unmanaged file.')
        result = self.run_tool('install_claude_skills.py')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(p.read_text(), 'Existing unmanaged file.')

    def test_helper_refuses_symlinked_state(self) -> None:
        outside = Path(self.temp.name)/'outside.json'
        outside.write_text('{}')
        state = self.root/'.claude/.managed-skill-copies.json'
        state.symlink_to(outside)
        result = self.run_tool('install_claude_skills.py')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(outside.read_text(), '{}')


    def test_validator_rejects_unknown_onboarding_copy(self) -> None:
        self.alter_json('test-design/fixtures/onboarding-views.json', lambda x: x['fixtures'][0]['view'].update(headlineKey='not.a.real.copy.key'))
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_validator_rejects_premature_no_matches(self) -> None:
        self.alter_json('test-design/fixtures/onboarding-views.json', lambda x: next(f for f in x['fixtures'] if f['id']=='VIEW-09')['view'].update(historyComplete=False))
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_validator_rejects_unlabeled_demo(self) -> None:
        self.alter_json('test-design/fixtures/presentation-demo.json', lambda x: x.update(exampleData=False))
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_validator_rejects_wrong_demo_net(self) -> None:
        self.alter_json('test-design/fixtures/presentation-demo.json', lambda x: x['purchases'][0].update(expectedNetMinor='9100'))
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_validator_rejects_missing_demo_evidence(self) -> None:
        self.alter_json('test-design/fixtures/presentation-demo.json', lambda x: x['evidence'].pop())
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_validator_rejects_missing_concrete_doc_link(self) -> None:
        p = self.root/'README.md'
        p.write_text(p.read_text()+'\nRequired reference: `docs/does-not-exist.md`.\n')
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_validator_rejects_start_button_in_wrong_state(self) -> None:
        self.alter_json('test-design/fixtures/onboarding-views.json', lambda x: x['fixtures'][0]['view'].update(canStartImport=True))
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

    def test_validator_rejects_secret_in_onboarding_projection(self) -> None:
        self.alter_json('test-design/fixtures/onboarding-views.json', lambda x: x['fixtures'][0]['view'].update(apiKey='synthetic-test-secret'))
        self.assertNotEqual(self.run_tool('validate_blueprint.py', '--require-schema').returncode, 0)

if __name__ == '__main__':
    unittest.main(verbosity=2)
