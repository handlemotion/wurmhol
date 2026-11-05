# 0019: Keep `wurmhol host` running, as a login service

Status: accepted. Extends ADR 0018 and spec v1 section 7 (the CLI).

## Context

`wurmhol host` (ADR 0018) connects a computer to the wall only while its terminal stays open.
Close the terminal, restart, or log out, and "Create from this computer" waits for a computer that
is not there. People who want it should not have to keep a terminal open for it.

A service that starts at login has to start a CLI that is still there on the next boot. The usual
way to run Wurmhol, `npx wurmhol`, runs it from npm's `_npx` cache, which npm clears or replaces
on another version. A service pointing into that cache breaks without warning.

## Decision

- **`wurmhol host --install`** registers `wurmhol host` to start at login and restart when it
  exits (after 30 s, so a revoked token or a dead network does not spin). It starts it at once.
  Running it again replaces the definition and restarts it. **`wurmhol host --uninstall`** stops
  it and removes the definition.
  - **macOS:** a launchd user agent, `~/Library/LaunchAgents/com.wurmhol.host.plist`, loaded with
    `launchctl bootstrap gui/<uid>`.
  - **Linux:** a systemd user unit, `~/.config/systemd/user/wurmhol-host.service`
    (`$XDG_CONFIG_HOME`), enabled for `default.target`. Without a systemd user manager (no
    `systemctl`, or no user bus, as in most containers) it refuses with one line that says to keep
    `wurmhol host` running in a terminal.
  - **Windows:** refused for now with the same line. A Scheduled Task at logon can start it, but
    not restart it when it exits or hide its console without a wrapper; that is a separate change.
- **It runs the installed CLI by absolute path:** `process.execPath` and the real path of the
  running CLI file. It refuses a CLI run from a throwaway location (npm's `_npx`, `pnpm dlx`,
  `bunx`, or the temporary directory) and prints the fix: `npm install -g wurmhol`, then
  `wurmhol host --install`. Any lasting install works (npm or pnpm global, a Homebrew Node, a
  checkout). A global `npm update -g wurmhol` keeps the same path, so the service picks up the new
  version at its next start.
- **The token stays in the credentials file.** The service runs `wurmhol host`, which reads the
  token `wurmhol login` saved (`credentials.json` under `WURMHOL_HOME`). `--install` logs in first
  when there is none for this server. The definition holds only `WURMHOL_HOME` and `WURMHOL_URL`,
  when set; the systemd unit also unsets a `WURMHOL_TOKEN` the user manager may carry, so the saved
  login is the one it uses. Proxy variables are not copied: `HTTPS_PROXY` can hold a password.
- **Logs** go to `logs/host.log` under `WURMHOL_HOME` (`~/.wurmhol` by default), stdout and stderr
  appended.
- **Pipes outlive the service**, as they outlive `wurmhol host` in a terminal: the unit uses
  `KillMode=process` and the agent `AbandonProcessGroup`, so stopping or restarting the service
  ends only `wurmhol host`.
- No `--status` yet: `systemctl --user status wurmhol-host` and `launchctl print
  gui/<uid>/com.wurmhol.host` answer it, and the computer shows in Create pipe when it is up.

## Consequences

- The service keeps the Node binary it was installed with. Removing that Node version (nvm,
  Volta) breaks it until `wurmhol host --install` runs again with the new one.
- A systemd user service runs while its user is logged in. Running it with no one logged in needs
  `loginctl enable-linger`, which we do not turn on.
- A revoked token leaves the service restarting every 30 s, each attempt logged with the fix.
  After `wurmhol logout`, `wurmhol host` starts a browser login and its code goes to the log, not
  to a person. `wurmhol host --uninstall` or a new `wurmhol login` ends either.
- Nothing changes on the Worker; self-hosted installs get it with the CLI.
