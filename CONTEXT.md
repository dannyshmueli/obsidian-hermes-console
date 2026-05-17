# Context

## Glossary

### Hermes Console

The Obsidian plugin product identity for the new Hermes-first terminal experience in Obsidian. The GitHub repository is `dannyshmueli/obsidian-hermes-console`.

- Also known as: Obsidian Hermes Console, Hermes Console for Obsidian
- Not: Lean Terminal as the public product identity
- Example: README badges and package metadata point to `obsidian-hermes-console`; user-facing UI says `Hermes Console`.

### Hermes Console plugin id

The canonical Obsidian manifest id for the renamed fork is `hermes-console`. The fork started from Lean Terminal, but this is a new plugin identity rather than an in-place Lean Terminal update.

- Also known as: manifest id, Obsidian plugin id, live plugin directory name
- Not: `lean-terminal` for the renamed fork
- Example: `manifest.json` should use `"id": "hermes-console"`; live installs should use `.obsidian/plugins/hermes-console`.

### New plugin identity

Hermes Console is treated as a new Obsidian plugin, not a migration of an installed Lean Terminal plugin. v1 does not need automatic migration from `lean-terminal` settings or install state.

- Also known as: clean plugin identity, new install path
- Not: automatic Lean Terminal settings migration
- Example: Users install Hermes Console under `.obsidian/plugins/hermes-console`; existing Lean Terminal installs remain separate unless a user manually changes files.

### Lean Terminal

The upstream foundation/history for Hermes Console. It remains relevant for technical credit, inherited architecture, and upstream comparison, but it is not the canonical public product identity for the new plugin.

- Also known as: upstream base, inherited terminal foundation
- Not: new public repo/product name or manifest id
- Example: README credits Lean Terminal while the primary repo is `dannyshmueli/obsidian-hermes-console`.

### Obsidian context bridge

The local JSON handoff from Hermes Console to Hermes. The Obsidian plugin captures the current note context at prompt submit time and writes a fresh payload to the vault bridge file. The bridge alone does not make Hermes understand the context; Hermes must load the companion integration.

- Also known as: bridge JSON, context handoff, `.obsidian/hermes/context.json`
- Not: terminal paste, clipboard transport, Hermes core attachment system
- Example: Plain Enter in Hermes Console writes selected-text/cursor/null context to `<vault>/.obsidian/hermes/context.json` before the PTY receives Enter.

### Hermes companion context integration

The repo-provided Hermes-side integration that reads the Obsidian context bridge through `pre_llm_call` and exposes `obsidian_context()` for full context fetches. A working v1 context feature requires this companion to be loaded/wired into the Hermes process launched by Hermes Console.

- Also known as: Hermes companion, pre-LLM hook, `obsidian_context()` tool
- Not: bundled Obsidian runtime code, Hermes core change
- Example: Hermes loads `hermes/obsidian_context_bridge.js`, reads `OBSIDIAN_CONTEXT_BRIDGE_PATH`, injects `<obsidian_context>` into the current model turn, and lets the model call `obsidian_context()` for large selections.

### Working context feature

The complete v1 context path: Obsidian captures context, writes the bridge JSON, launches/runs Hermes with the bridge path available, and Hermes loads the companion `pre_llm_call`/`obsidian_context()` integration.

- Also known as: end-to-end context attachment
- Not: only writing a bridge file, only showing UI status, or only documenting a loader
- Example: User selects text in an Obsidian note, asks Hermes “rewrite this,” and the active Hermes turn receives that selection via the companion pre-LLM hook without visible terminal paste.

### Terminal tab close

A user action that closes a Hermes Console terminal tab after an explicit yes/no confirmation. Closing a tab terminates the associated PTY/session process; it does not hide the tab while keeping the process alive.

- Also known as: tab `x`, close tab
- Not: hide, detach, safe-hide, background live process preservation
- Example: User clicks `x`, confirms the dialog, and the tab closes with its terminal process stopped. If the user cancels, the tab and process remain running.

### Destructive kill

A separate stronger action for explicitly terminating a terminal/session process when the action is dangerous, ambiguous, or requires exact-title confirmation.

- Also known as: kill terminal, force terminate
- Not: normal tab close
- Example: User invokes a kill command/menu action and must confirm with the exact terminal title before process termination proceeds.
