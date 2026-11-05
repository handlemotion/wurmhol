---
name: wurmhol
description: Share a running local server at a private HTTPS URL the user opens in their own browser. Use when the user wants to see, open, try or review something you are running (a dev server, a preview, a built site), including from a cloud sandbox where localhost is out of their reach.
---

# Share a local server with wurmhol

The user cannot open `localhost` on your machine. `wurmhol` gives a port a private URL that only
signed-in members of the token's org can open.

1. **Start the server** and note the port it actually listens on (read it from the server's
   output: Vite moves to the next free port when 5173 is taken).
2. **Share it:** `npx wurmhol <port>`. It returns once the pipe answers and prints the URL as its
   first line (`--json` prints `{url, port, id}`). The pipe keeps running after the command
   returns; a server that restarts on the same port stays shared. When the URL must stay the
   same (an OAuth redirect URI, a link the user keeps), add `--name <name>`: the pipe opens at
   `https://<name>.wurmhol.dev` every time, and `npx wurmhol stop <name>` ends it.
   If the app's OAuth redirect URI is on `https://oauth.wurmhol.dev`, any number of pipes of it can
   sign in at once: the relay sends each callback back to the pipe that started it.
3. **Send the user the URL** in your reply, as a plain link. They sign in to open it.
4. **Stop it when the user is done looking:** `npx wurmhol stop <port>`. `npx wurmhol ls` lists
   what is open; `npx wurmhol stop --all` ends every pipe.

## Errors say the fix

Every failure is one line on stderr that names the fix. Do what it says, then run the same
command again:

- **Token missing or revoked:** in a Claude Code cloud environment, the user makes a token in the
  console (menu → Tokens) and sets `WURMHOL_TOKEN` under Environment variables, which takes
  effect in a new session. On a machine that keeps its files (a laptop, SSH, a VM), run
  `npx wurmhol login` and send the user the URL and code it prints to approve. Tell the user
  which applies, and stop there.
- **Proxy refused the connection:** the sandbox only reaches listed hosts. The error names the
  host; the user adds it to the environment's Allowed domains (Network access).
- **TLS verification failed:** set `NODE_EXTRA_CA_CERTS` to the sandbox's CA bundle and retry.
- **Nothing on the port yet:** the pipe opens anyway and its page says it is waiting for the
  server; start the server.
- **Plan or limit:** relay the line to the user word for word; it is theirs to act on.

## The token is a credential

`WURMHOL_TOKEN` (`wh_…`) lets anyone open pipes for the user's org. Check it by presence only
(`test -n "$WURMHOL_TOKEN"`); keep it out of your output, files, commits and URLs. When it is
missing, ask the user to set it in the environment rather than paste it into the chat.
