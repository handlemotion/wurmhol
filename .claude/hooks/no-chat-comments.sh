#!/bin/sh
# PreToolUse hook (AGENTS.md, "Comments and prose"): refuses an edit whose new text adds a
# comment about the conversation or the edit itself ("used to be x", "as requested"). Comments
# describe the code as it is, for whoever reads it next.
PATTERN='(//|#|/\*|\*|<!--).*\b(changed from|previously (this|it)|used to be|as requested|as discussed|per (your|the user'"'"'s) request)\b'
command -v jq >/dev/null 2>&1 || exit 0
added=$(jq -r '.tool_input | (.new_string // .content // ([.edits[]?.new_string] | join("\n")))')
if printf '%s\n' "$added" | grep -qiE "$PATTERN"; then
  echo "Write comments for the code, not the chat: describe what the code does now, not how it changed or who asked (AGENTS.md)." >&2
  exit 2
fi
exit 0
