#!/usr/bin/env python3
"""Verify a separately retrieved policy checkout; never used by builds."""
import hashlib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
lock = json.loads((root / 'dev-standards.lock.json').read_text())
if len(sys.argv) != 2:
    sys.exit('usage: python3 scripts/verify-standards.py /path/to/dev-standards')
source = pathlib.Path(sys.argv[1]).resolve()
sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
if sha != lock['commit']:
    sys.exit('Standards commit does not match the adoption pin')
for name, expected in lock['files'].items():
    if hashlib.sha256((source / name).read_bytes()).hexdigest() != expected:
        sys.exit(f'Standards digest mismatch: {name}')
print(f"Verified edition {lock['edition']}, commit {sha}, {len(lock['files'])} files")
