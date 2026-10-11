#!/usr/bin/env python3
"""Copy canonical skills for Claude discovery without overwriting user changes."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    state_path = ROOT / '.claude' / '.managed-skill-copies.json'
    try:
        if state_path.is_symlink() or state_path.parent.is_symlink():
            raise ValueError('Refusing symlinked managed-state path.')
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if not isinstance(state, dict):
            raise ValueError('Managed skill state must be an object.')
        actions = []
        for source in sorted((ROOT / '.agents' / 'skills').glob('*/SKILL.md')):
            target = ROOT / '.claude' / 'skills' / source.parent.name / 'SKILL.md'
            key = str(target.relative_to(ROOT))
            # Refuse symlinked destinations/parents; this helper must stay inside the repo.
            if any(p.is_symlink() for p in (target, target.parent, target.parent.parent, target.parent.parent.parent)):
                raise ValueError(f'Refusing symlinked destination: {key}')
            new_bytes = source.read_bytes()
            new_hash = digest(new_bytes)
            if target.exists():
                old_hash = digest(target.read_bytes())
                if old_hash != new_hash and old_hash != state.get(key):
                    raise ValueError(f'Refusing to overwrite unmanaged or modified file: {key}')
            actions.append((target, key, new_bytes, new_hash))
        for target, key, content, checksum in actions:
            print(('Would synchronize ' if args.dry_run else 'Synchronizing ') + key)
            if not args.dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                state[key] = checksum
        if not args.dry_run:
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(json.dumps(state, indent=2) + '\n')
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
