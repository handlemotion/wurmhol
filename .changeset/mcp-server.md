---
"wurmhol": minor
---

Add `wurmhol mcp`, a stdio MCP server with `open_pipe`, `list_pipes` and `stop_pipe` tools for agents. It finds its token like the CLI (`WURMHOL_TOKEN`, else `wurmhol login`), and its pipes end when the agent's MCP session ends.
