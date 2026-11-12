# Abacus Aurora

The abacus counts, the aurora celebrates. A Claude Code mod that shows where your 5-hour limit goes.

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
- `/aurora reset`: forget the calibration
