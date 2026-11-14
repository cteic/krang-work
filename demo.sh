#!/usr/bin/env bash
# A complete run of the work store against a throwaway directory:
#
#   a thought is captured -> it becomes an issue -> an agent tries to claim it
#   and is refused -> the owner approves -> two agents race and one wins ->
#   the winner submits evidence -> the owner accepts -> git shows the history.
#
# Nothing here touches the real store, the network, or a model. The "agent" is
# this script writing JSON-RPC to the server's stdin, which is exactly what an
# MCP client does.
#
#   ./demo.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cli="$here/src/cli.ts"
work="$(mktemp -d "${TMPDIR:-/tmp}/krang-work-demo.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export KRANG_WORK_DIR="$work/work"

kw() { node --experimental-strip-types --no-warnings "$cli" "$@"; }

# Send tool calls to a fresh server and print each tool's JSON result.
# Usage: mcp '<tool> <json-arguments>' ...
mcp() {
  {
    echo '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}'
    echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    local n=0
    for request in "$@"; do
      n=$((n + 1))
      printf '{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n' \
        "$n" "${request%% *}" "${request#* }"
    done
  } | kw mcp 2>/dev/null |
    node -e '
      const lines = require("node:fs").readFileSync(0, "utf8").trim().split("\n");
      for (const line of lines.slice(1)) console.log(JSON.parse(line).result.content[0].text);
    '
}

step() { printf '\n== %s\n' "$1"; }

step "1. Create a work directory, with git for history"
kw init --prefix DEMO
git -C "$KRANG_WORK_DIR" config user.name "Demo"
git -C "$KRANG_WORK_DIR" config user.email "demo@example.invalid"

step "2. Capture a thought: one command, no model"
kw jot "greet.txt should exist and say hello" --tag demo
thought="$(kw thoughts | head -1 | cut -d' ' -f1)"

step "3. The thought turns out to be work: make it an issue"
kw thoughts issue "$thought" --title "Write a greeting file" \
  --criterion "greet.txt contains the word hello" --sensitivity normal

step "4. An agent lists the work over MCP"
mcp 'issue_list {}'

step "5. The agent tries to claim it before approval: refused"
mcp 'issue_claim {"id":"DEMO-1","actor":"agent-a"}'

step "6. The agent tries to approve it itself: refused, there is no such field"
mcp 'issue_update {"id":"DEMO-1","actor":"agent-a","approved":true}'

step "7. The owner approves it from the command line"
kw issue approve DEMO-1 --as owner | head -7

step "8. Two agents claim it: one wins"
mcp 'issue_claim {"id":"DEMO-1","actor":"agent-a"}' | grep -E '"(status|claimed_by)"'
mcp 'issue_claim {"id":"DEMO-1","actor":"agent-b"}'

step "9. The winner does the work and submits evidence"
echo "hello" >"$work/greet.txt"
proof="grep -c hello greet.txt printed $(grep -c hello "$work/greet.txt")"
mcp "issue_update {\"id\":\"DEMO-1\",\"actor\":\"agent-a\",\"add_evidence\":[\"$proof\"],\"handoff\":\"Wrote greet.txt.\",\"status\":\"in_review\"}" |
  grep -E '"status"'

step "10. The owner reviews and accepts"
kw issue review DEMO-1 --accept --as owner | head -3

step "11. A sensitive issue, as a cloud client sees it: a stub"
kw issue add "Invented private issue" --description "A cloud client must never see this sentence." >/dev/null
mcp 'issue_get {"id":"DEMO-2"}'

step "12. The issue is a plain file"
sed -n '1,8p' "$KRANG_WORK_DIR/issues/DEMO-1.md"

step "13. Its history is the git log"
git -C "$KRANG_WORK_DIR" log --format='%s' -- issues/DEMO-1.md
