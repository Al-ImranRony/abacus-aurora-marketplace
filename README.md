# irony-mods

Claude Code mods by Rony. MIT licensed; changes go through a pull request (see CONTRIBUTING.md).

## Abacus Aurora

Shows where your 5-hour limit goes: the window split into this device and other devices, each task's share, live token
counts, a suggested next step with the model to use, and fireworks when a piece of work lands. Details in
[abacus-aurora/README.md](abacus-aurora/README.md).

## Install

Needs Claude Code. No GitHub login required.

```bash
claude plugin marketplace add Al-ImranRony/abacus-aurora-marketplace
claude plugin install abacus-aurora@irony-mods
```

Start a new Claude Code session and run `/aurora` to open the pane. Inside a session the same works as
`/plugin marketplace add Al-ImranRony/abacus-aurora-marketplace`, then `/plugin install abacus-aurora@irony-mods`.

**Update:**

```bash
claude plugin marketplace update irony-mods
claude plugin update abacus-aurora@irony-mods
```

**Remove:** `claude plugin uninstall abacus-aurora@irony-mods`

The 5-hour bar and the device split read your Claude subscription sign-in; an API-key account has no 5-hour window to show.

