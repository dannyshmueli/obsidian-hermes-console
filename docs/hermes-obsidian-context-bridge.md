# Hermes Obsidian context bridge

Hermes Console uses one Obsidian plugin and one Hermes plugin, connected by local JSON files inside your vault.

The Obsidian plugin is **Hermes Console**. It owns the terminal UI, tabs, PTY sessions, per-tab note/PDF selection and cursor capture, and the busy/idle tab indicators.

The Hermes plugin is **obsidian-context-bridge**. It appears in Hermes Plugins because it runs inside Hermes. It registers Hermes hooks, injects note/PDF selection or cursor context before the LLM call, exposes the `obsidian_context()` tool for large selections, and writes per-tab busy/idle status for the Obsidian UI.

It is not a second Obsidian plugin.

## Fast path

Community Plugins installs the Obsidian plugin assets only. It does not install Hermes Agent and it does not auto-enable Hermes plugins.

1. Install **Hermes Console** from **Settings > Community Plugins**.
2. Enable **Hermes Console**.
3. Click **Settings > Hermes Console > Download binaries**.
4. Make sure `hermes` is installed and available to the shell launched by Obsidian.
5. Install and enable the Hermes-side bridge once:

   ```bash
   hermes plugins install dannyshmueli/obsidian-hermes-console#hermes --enable
   ```

6. Open Hermes Console, enable the **Send context to Hermes** header toggle for the terminal tab you want to use, select text in a note or a PDF (or put your cursor in a note), type a prompt, and press Enter.

Note context sharing is opt-in per Hermes Console terminal tab. The tab header toggle defaults off after plugin reload or Obsidian restart, so enable it again for each terminal tab that should share note context. You can also run **Toggle note context for active Hermes Console tab** from the command palette and bind that command under Settings > Hotkeys.

## What users see in Hermes Plugins

Seeing `obsidian-context-bridge` in Hermes Plugins is expected.

Call it the **Hermes plugin** or **Hermes companion plugin** when explaining the architecture. Do not call it an Obsidian plugin.

It is dashboard-only/no-UI in Hermes because its job is not to render a tab. Its job is to:

- read `<vault>/.obsidian/hermes/context.json`
- inject fresh selected-text or cursor context before the LLM call
- expose `obsidian_context()` for large selections
- write `<vault>/.obsidian/hermes/runtime/<tab-id>.json` so Hermes Console can show busy/idle tab state

## Architecture

```text
Obsidian note selection/cursor
  -> Hermes Console Obsidian plugin
  -> <vault>/.obsidian/hermes/context.json
  -> OBSIDIAN_CONTEXT_BRIDGE_PATH
  -> obsidian-context-bridge Hermes plugin
  -> current Hermes turn
```

Busy/idle status uses a second local JSON side channel:

```text
Hermes hooks
  -> obsidian-context-bridge Hermes plugin
  -> <vault>/.obsidian/hermes/runtime/<tab-id>.json
  -> Hermes Console tab spinner / unread dot / optional Obsidian Notice
```

These bridge files are just JSON. They are not sockets, servers, clipboard paste, or network connections.

## Context bridge file

Hermes Console writes the current attachment state to:

```text
<vault>/.obsidian/hermes/context.json
```

Plain Enter writes a fresh marker before the PTY receives Enter. If note context sharing is enabled for that terminal tab, Hermes Console sends the current selection first; if nothing is selected, it sends cursor/file context for the active Markdown note.

When note context sharing is off for that terminal tab, the marker has:

```json
{"attach":{"enabled":false},"context":null}
```

Hermes consumers must treat that as a fresh detach and clear any previously accepted selected text.

## PDF context

A PDF open in Obsidian renders inside the plugin's bundled pdf.js viewer, which has no CodeMirror editor and keeps its selection in the DOM only. Hermes Console therefore reads that DOM selection (`div.page[data-page-number]` and its `textLayer` spans), maps it onto the page it came from, and snapshots it while it is still live: clicking into the console terminal to press Enter clears the viewer's selection, so a snapshot taken at submit time would always be empty. The snapshot is refreshed on `selectionchange`, `keyup` and `pointerup`.

The snapshot travels through the same `context.json` as a note selection, with one extra field:

```json
{
  "context": {
    "type": "selection",
    "file": { "path": "papers/study.pdf", "name": "study.pdf" },
    "selectedText": "3.1 引言 传统工业装配任务…",
    "lineCount": 1,
    "charCount": 295,
    "hash": "458acab50d8b6ce7",
    "pdf": { "pageFrom": 33, "pageTo": 33, "pageCount": 1, "totalPages": 102 }
  }
}
```

`range` and `lineCount` are still filled from the page's text, so a Hermes-side consumer written before this field existed keeps working; `pdf` is additive, and `totalPages` is `null` when the viewer did not report a page count.

The console header shows the page and the selection size in words (`PDF p.33 (51 words)`). The word count follows the 字数 convention Chinese word processors use rather than whitespace tokens: each CJK character counts once, each run of Latin letters/digits counts once, punctuation counts zero - a whole Chinese paragraph would otherwise read "1 word". `charCount` stays in the payload (the host budgets in characters), it is just no longer what the header prints.

When a note selection and a PDF selection are both available, the more recent one wins: the tracker timestamps both and attaches whichever the user selected last.

### Pulling whole pages with `@pdf:`

A selection is a few hundred characters by design. To get pages into the prompt, use the `@pdf:` context reference that the Hermes plugin registers (`@pdf:` completion also lists the vault's PDFs with their page counts, plus `current`):

| Reference | Expands to |
| --- | --- |
| `@pdf:paper.pdf` | the whole document, capped |
| `@pdf:paper.pdf:84` | page 84 |
| `@pdf:paper.pdf:84-86` | pages 84 to 86 |
| `@pdf:current` | the PDF the last bridge payload pointed at |
| `@pdf:current:85-90` | that PDF, pages 85 to 90 |

Expansion reads the text with `pdftotext` (`pdfinfo` supplies the page count) from poppler, which preserves the line structure of the page and is cleaner than the selection path, where pdf.js spans can run together across a header. A scanned PDF with no text layer answers with an explicit message instead of silence. Paths resolve inside the vault, and a reference pointing outside it is refused.

Each reference reads at most 10 pages and 12000 characters by default (`OBSIDIAN_PDF_REF_MAX_PAGES`, `OBSIDIAN_PDF_REF_MAX_CHARS`), and says so in the text when it hits a cap, so Hermes can ask for the next window instead of assuming the document ended.

The vault root comes from `OBSIDIAN_PDF_VAULT_ROOT` when set, otherwise the `vaultPath` in `context.json`, otherwise the bridge file's own location (three levels up). The `@pdf:` header always prints the vault-relative path, including when the vault root is a symlink.

## Busy/idle status files

For each terminal tab, Hermes Console sets environment variables before spawning the PTY:

```text
OBSIDIAN_HERMES_TAB_ID=terminal-1
OBSIDIAN_HERMES_STATUS_PATH=<vault>/.obsidian/hermes/runtime/terminal-1.json
OBSIDIAN_HERMES_STATUS_DIR=<vault>/.obsidian/hermes/runtime
```

The Hermes plugin writes status JSON on these hooks:

- `pre_llm_call` -> `busy`
- `post_llm_call` -> `idle`
- `on_session_end` -> `idle`
- `on_session_finalize` -> `idle`

Hermes Console watches the status file and uses it for:

- spinner while a Hermes turn is running
- unread dot when a background Hermes tab becomes idle
- optional Obsidian Notice when a background Hermes turn finishes

This replaced the older OSC/prompt-parsing experiment. Terminal output is not the source of truth for Hermes busy state.

## Manual Hermes plugin installation

Most users should use the one-line install:

```bash
hermes plugins install dannyshmueli/obsidian-hermes-console#hermes --enable
```

`#hermes` points at the Hermes-side plugin inside this repository (about 60 KB). `hermes plugins install dannyshmueli/obsidian-hermes-console` installs the repository root as well, but also clones the Obsidian plugin sources and the prebuilt binaries (about 36 MB), and current Hermes builds require `--force` for that form because the install scanner reports those binaries and documentation files as caution findings.

Use manual install only when you run Hermes outside Hermes Console or maintain a custom Hermes profile.

The Hermes plugin files live in this repository under:

```text
hermes/plugin.yaml
hermes/__init__.py
hermes/obsidian_context_bridge.js
hermes/obsidian_status_bridge.py
```

If you copy the plugin manually, install those files as a Hermes plugin named `obsidian-context-bridge`, then enable it in Hermes config.

For context injection, the Hermes process must receive:

```text
OBSIDIAN_CONTEXT_BRIDGE_PATH=/path/to/vault/.obsidian/hermes/context.json
```

For tab busy/idle state, the Hermes process must receive the `OBSIDIAN_HERMES_*` variables listed above.

Hermes Console sets these environment variables automatically for terminal sessions it launches.

## Runtime behavior

- Missing or unreadable context bridge file: no context injected; `obsidian_context()` returns null.
- `attach.enabled=false`: no context injected; previously accepted context is cleared. This is the default after plugin reload or Obsidian restart until the user enables the tab's **Send context to Hermes** header toggle or runs **Toggle note context for active Hermes Console tab**.
- Selection context: small selections are injected inline as serialized text.
- Large selections: Hermes gets a preview and can call `obsidian_context()` for the full text.
- Cursor context: Hermes gets file path, cursor position, current line, and nearby lines.
- Freshness window: stale payloads are rejected.
- Reuse guard: the same bridge payload is not injected twice.
- Missing or unreadable status file: no busy/idle UI update for that tab until a fresh status file is written.

## Troubleshooting

If Obsidian writes the bridge file but Hermes does not see context:

1. Confirm Hermes was launched from Hermes Console, not an unrelated external terminal.
2. Confirm the Hermes Plugins screen shows `obsidian-context-bridge` enabled.
3. Confirm the terminal environment contains `OBSIDIAN_CONTEXT_BRIDGE_PATH`.
4. Confirm `<vault>/.obsidian/hermes/context.json` updates when you press Enter.
5. Confirm the **Send context to Hermes** header toggle is on for the active terminal tab, or run **Toggle note context for active Hermes Console tab** from the command palette.
6. Restart Hermes Console after changing plugin settings or binaries.

If the tab spinner or background-finished notice does not work:

1. Confirm Hermes was launched from Hermes Console.
2. Confirm the Hermes Plugins screen shows `obsidian-context-bridge` enabled.
3. Confirm the terminal environment contains `OBSIDIAN_HERMES_STATUS_PATH` and `OBSIDIAN_HERMES_TAB_ID`.
4. Confirm `<vault>/.obsidian/hermes/runtime/<tab-id>.json` updates during a Hermes turn.
5. Disable and re-enable Hermes Console, or restart Obsidian, after changing plugin files.

If PDF selections stay out of Hermes:

1. Confirm the PDF is open in Obsidian's own viewer; an external viewer cannot feed the bridge.
2. Select text inside a page and check the console header: `PDF p.…` means the snapshot was taken, a note label means the last selection was in a note.
3. `@pdf:` needs poppler - `which pdftotext pdfinfo`. Without it, references answer that no text layer was found.

Do not install another Obsidian plugin. There is only one Obsidian plugin: Hermes Console.
