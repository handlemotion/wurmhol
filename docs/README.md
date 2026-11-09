# Documentation map

Start with the file for the task, not every document in the repository.

| Need                                           | Source                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Agent-wide rules and task routing              | [AGENTS.md](../AGENTS.md); [CLAUDE.md](../CLAUDE.md) imports it                                      |
| Local setup, commands, testing, package map    | [Development](development.md)                                                                        |
| PRs, stacks, releases, production verification | [Contributing](contributing.md)                                                                      |
| Cloudflare tooling, Doppler, deploy operations | [Operations](operations/doppler.md)                                                                  |
| UI rules                                       | [DESIGN.md](../DESIGN.md) and the skills it names                                                    |
| Product usage and self-hosting                 | [Mintlify source](../apps/docs/README.md), published at [wurmhol.com/docs](https://wurmhol.com/docs) |
| Configuration contract                         | [Worker environment example](../apps/worker/.dev.vars.example)                                       |
| Architecture and decision history              | Original [v1 spec](spec/v1.md), amended by [ADRs](adr/)                                              |
| Outstanding hosted setup                       | [Launch to-do](../TODO.md); verify external account state before acting                              |
| Vulnerability reporting                        | [SECURITY.md](../SECURITY.md)                                                                        |

Package scripts and workflow files define executable commands. Keep the development and
operations guides in sync with them. Accepted ADRs amend the original spec; proposed ADRs
are design discussions, not instructions or proof that a feature shipped. Historical specs,
ADRs, and changelogs are not operational runbooks.

## Maintaining agent documentation

Use progressive disclosure: essential cross-cutting rules and a task-to-document map first,
then the relevant guide, then a skill's supporting references only when needed.

- Keep safety boundaries and mandatory checks in `AGENTS.md`; put detailed procedures in the
  linked guide or skill. Plain Markdown links let agents choose what to read. Do not add
  eager `@` imports of every guide to `CLAUDE.md`.
- Each procedure has one maintained home. Link to it instead of copying command sequences
  into multiple agent files. Add scoped `AGENTS.md` files only for genuinely local rules.
- Use clear task triggers in links and skill descriptions. Repo skills live in
  `.claude/skills/`, exposed through `.agents/skills/` symlinks for other hosts.
- Check commands and paths against source before editing. Remove completed checklist items
  and template prose. Do not silently turn historical proposals into current policy or mark
  external setup done without verification.
- Validate relative links after moving guidance. Keep reference chains shallow, and preserve
  security, approval, and verification requirements when shortening instructions.

This structure follows [Anthropic's context-engineering guidance](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents),
[Claude Code's concise project-instruction guidance](https://code.claude.com/docs/en/best-practices#keep-claude-md-short),
and [OpenAI's scoped AGENTS.md guidance](https://developers.openai.com/codex/agent-configuration/agents-md).
Both [Anthropic](https://www.anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills)
and [OpenAI](https://developers.openai.com/codex/build-skills) describe on-demand skill loading
as progressive disclosure. Smaller always-loaded instructions reduce context, but are not
evidence of improved agent task performance by themselves.
