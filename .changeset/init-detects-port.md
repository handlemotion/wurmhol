---
"wurmhol": minor
---

`wurmhol init` writes the agent line with the dev server's port from `package.json` (Next 3000,
Astro 4321, Vite 5173, else 8787), says whether a token is set (`WURMHOL_TOKEN` or
`wurmhol login`) and how to get one, and `--skill` writes the `wurmhol` skill to
`.claude/skills/wurmhol/SKILL.md`.
