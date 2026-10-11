#!/usr/bin/env python3
"""Audit blueprint syntax and frontmatter; not an application or agent runtime test."""
from __future__ import annotations

import ast
import json
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    try:
        import yaml
    except ImportError:
        print('PyYAML is required for the frontmatter audit; no check was claimed.', file=sys.stderr)
        return 1
    counts = {'jsonFiles': 0, 'tomlFiles': 0, 'yamlFrontmatterDocuments': 0, 'pythonFiles': 0}
    try:
        for path in sorted(ROOT.rglob('*')):
            if not path.is_file() or '__pycache__' in path.parts:
                continue
            if path.suffix == '.json':
                json.loads(path.read_text(encoding='utf-8'))
                counts['jsonFiles'] += 1
            elif path.suffix == '.toml':
                tomllib.loads(path.read_text(encoding='utf-8'))
                counts['tomlFiles'] += 1
            elif path.suffix == '.py':
                ast.parse(path.read_text(encoding='utf-8'), filename=str(path.relative_to(ROOT)))
                counts['pythonFiles'] += 1
            elif path.suffix == '.md':
                text = path.read_text(encoding='utf-8')
                if text.startswith('---\n'):
                    match = re.match(r'^---\n(.*?)\n---(?:\n|$)', text, re.DOTALL)
                    if not match:
                        raise ValueError(f'Unterminated YAML frontmatter: {path.relative_to(ROOT)}')
                    data = yaml.safe_load(match.group(1))
                    if not isinstance(data, dict):
                        raise ValueError(f'Frontmatter is not a mapping: {path.relative_to(ROOT)}')
                    counts['yamlFrontmatterDocuments'] += 1
        report = {'status': 'passed', 'scope': 'package syntax only; no application/runtime/permission tests', 'counts': counts}
        target = ROOT/'evidence'/'package-syntax-audit.json'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
        print(json.dumps(report, indent=2))
        return 0
    except (ValueError, OSError, SyntaxError, yaml.YAMLError) as exc:
        print(f'Package syntax audit failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
