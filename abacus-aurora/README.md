# Abacus Aurora

The abacus counts, the aurora celebrates. A Claude Code mod that shows where your 5-hour limit goes.

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

**Pane** (`/aurora`): one bar for the 5-hour window, split into *this device* and *other devices*; the reset time and
weekly figure; this device's tasks in the window (all sessions on this machine, the running one marked ●), each with its
share; the suggested next step.

**Card under each task**: the task's share of the 5-hour limit, tokens, duration, the window's split now, and the
suggested next step with *Use as prompt* / *Switch model*.

## How the split stays accurate with several devices

- The window figure is the account-wide reading every API response carries, so every device shows the same total.
- A task's share = its API-equivalent cost (the engine's own cost ledger, exact per model) × this account's
  %-per-dollar rate. Nothing another device does enters a task's cost.
- The rate is learned on this device: each time the window moves a full point during continuous activity, the
  movement is divided by what this device spent meanwhile. Other devices only ever *add* movement, so those samples
  read high; the rate is the 25th percentile of the last 20, and a gap over 10 minutes restarts the span.
- **Several devices: fix one rate on all of them.** Each device learns its rate alone, and "other devices" is whatever its
  own estimate leaves over, so two devices only mirror each other when they use the same rate. A light device that
  mostly works while a busy one is running learns a rate that is too high, and overstates its own share; the pane flags
  it ("Rate likely inflated"). Read the rate off your main device's pane (or `/aurora rate`) and run
  `/aurora rate <n>` with that figure on every device: each device's *this device* then equals the other's
  *other devices*. Use from claude.ai or anywhere outside Claude Code still counts as other devices.
- Other devices = window − this device. This device is never shown above the window; if it would be, its tasks are
  scaled down together.
- The ledger lives in the mod's store, so every session on this machine shares it; it empties when the window resets.

A task is what you asked for. When a background job or subagent finishes and wakes the session, that turn joins the
task it belongs to (one row, one card, its total cost); only a prompt you send starts a new one. The next step and the
milestone check wait 30s after the task goes quiet, so a burst of wake-ups asks Haiku once.

Not counted as this device: the mod's own Haiku next-step calls (outside the engine's cost ledger, tiny).

## Commands

- `/aurora`: open the pane
- `/aurora party`: fireworks now
- `/aurora next`: recompute the last suggestion
- `/aurora recs on|off`, `/aurora fx on|off`: toggle suggestions or celebrations
- `/aurora rate`: show the rate in use; `/aurora rate <n>` fixes it (same figure on every device), `/aurora rate auto` learns again
- `/aurora reset`: forget the calibration (a fixed rate stays)
