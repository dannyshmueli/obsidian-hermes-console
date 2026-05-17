# Session Persistence

Each terminal tab's name, color, working directory, and scrollback buffer are saved to the workspace layout on close and on Obsidian quit. On next launch, tabs are restored with their history visible and a fresh shell spawned in the saved directory. This is visual/history restore - the underlying shell process does not survive quit.

Closing a tab (**x** button) pushes its state to a rescue ring buffer stored in plugin data. Use **Restore console or Hermes session** from the command palette to re-open a closed tab or resume a Hermes session. Closed terminal entries restore scrollback only; Hermes session entries read live `hermes sessions list` output and start a fresh terminal with `hermes --resume <session-id>`.
