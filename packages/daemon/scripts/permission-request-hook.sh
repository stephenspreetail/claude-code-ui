#!/bin/bash
# Hook script for PermissionRequest events
# Writes pending permission info to ~/.claude/pending-permissions/<session_id>.json
# This allows external tools to detect when Claude Code is waiting for user approval
#
# Install by adding to ~/.claude/settings.json:
# {
#   "hooks": {
#     "PermissionRequest": [{
#       "type": "command",
#       "command": "/path/to/permission-request-hook.sh"
#     }]
#   }
# }

PENDING_DIR="$HOME/.claude/pending-permissions"
mkdir -p "$PENDING_DIR"

# Read JSON from stdin
INPUT=$(cat)

# Extract session_id
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -n "$SESSION_ID" ]; then
  # Write pending permission with timestamp
  # Include tool_name and tool_input for display in UI
  echo "$INPUT" | jq -c '. + {pending_since: (now | tostring)}' > "$PENDING_DIR/$SESSION_ID.json"
fi
