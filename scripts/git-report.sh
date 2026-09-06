#!/usr/bin/env bash
set -euo pipefail
REPO="${1:-.}"
python3 - "$REPO" <<'PY'
import json, subprocess, sys
repo = sys.argv[1]
def git(*args):
    return subprocess.check_output(["git", "-C", repo, *args], text=True).strip()

def lines(value):
    return [line for line in value.splitlines() if line]

print(json.dumps({
    "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
    "commit": git("rev-parse", "HEAD"),
    "status": lines(git("status", "--porcelain")),
    "diff_stat": git("diff", "--stat"),
    "changed_files": lines(git("diff", "--name-status")),
}, ensure_ascii=False, indent=2))
PY
