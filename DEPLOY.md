# Deploying dsh-operator-ui

The runbook for putting the plugin on a real DSH host. Everything here is
reversible — the last section is the uninstall.

## Requirements

- DSH `0.1.0-rc.6` (the verified pin) with the `web` profile in use.
- For the Git/Files tabs: `git` on PATH (read-only usage only).
- For the Browser tab: Chrome/Chromium on the host. Override the binary with
  `DSH_OPERATOR_UI_CHROME=/path/to/chrome` if it's not in a default location.
- For the Workflows tab: an Archon API. Default `http://127.0.0.1:3090`;
  override with `DSH_OPERATOR_UI_ARCHON`.

## Install

```sh
git clone https://github.com/Foshowithit/dsh-operator-ui.git
cd dsh-operator-ui
node scripts/check.js                 # must PASS before proceeding
dsh plugin --profile web add "$PWD"
```

The plugin self-inserts its bundle row; no manual `cordis.patch.yml` edit.

If your `dsh` runs under systemd, add the env vars to the unit (or its
drop-in) and restart it once:

```ini
# ~/.config/systemd/user/dsh-web.service.d/30-operator-ui.conf
[Service]
Environment=DSH_OPERATOR_UI_ARCHON=http://127.0.0.1:3090
# Environment=DSH_OPERATOR_UI_CHROME=/usr/bin/chromium
```

```sh
systemctl --user restart dsh-web
```

## Post-install verification (2 minutes)

1. Open the web UI → tabs read: Chat · Trajectory · Runs · Summary · Git ·
   Browser · Files · Workflows.
2. **Runs**: every session listed with status/context; blanks hidden unless
   you toggle the `blanks` chip.
3. **Git**: open a session in a git repo — branch, changes, and per-file
   diffs render.
4. **Browser**: type a URL → a live view appears within a few seconds; stop
   it with the button; it also self-stops after 10 idle minutes.
5. **Workflows**: with Archon reachable you see catalog + runs + decisions;
   with it down you see the honest "not reachable" panel (that's correct).
6. `⌘K` / `Ctrl+K` opens the palette.

## Uninstall

```sh
dsh plugin --profile web remove dsh-operator-ui
systemctl --user restart dsh-web   # if applicable
```

Sessions, settings, and history are untouched (the plugin persists nothing).
The supervised browser, if running, is torn down with the plugin.

## Safety notes for shared hosts

- The plugin's host half only ever: runs read-only `git` (fixed argv), reads
  workspace files under the session's root, drives its OWN single supervised
  browser (dedicated profile, idle-reaped), and GETs the Archon API.
- It never writes to git, never touches other processes' browsers, and never
  persists data outside `$DSH_HOME/operator-ui-browser` (its throwaway
  browser profile).
