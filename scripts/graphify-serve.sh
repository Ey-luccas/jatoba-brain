#!/usr/bin/env bash
set -euo pipefail
GRAPH_FILE="${1:-graphify-out/graph.json}"
PORT="${2:-8080}"
python -m graphify.serve "$GRAPH_FILE" --transport http --port "$PORT"
