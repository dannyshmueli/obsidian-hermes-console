# Changelog

All notable changes to Hermes Console are documented here.

## Unreleased

## 1.1.15 - May 23, 2026

### Improvements

- Polish the Hermes Console header with a generated feathered Hermes wing logo, compact brand spacing, and a subtle Console for Obsidian subtitle.
- Remove the unclear tiny Obsidian diamond mark from the header subtitle.
- Embed the generated wing artwork in CSS so the logo renders reliably in Obsidian without relying on relative asset loading.

### Improvements

- Document note context sharing as opt-in per Hermes Console terminal tab: use the **Send context to Hermes** header toggle, or bind **Toggle note context for active Hermes Console tab** from the command palette; the per-tab toggle defaults off after plugin reload or Obsidian restart.
- Clarify that enabled note context sharing sends the current selection first, or cursor/file context when nothing is selected, and remove stale global context-setting wording.

## 1.1.14 - May 19, 2026

### Improvements

- Reorder settings around first-run setup: Basic setup, Hermes session integration, Notifications, Shell environment & behavior, Session persistence, then Appearance and Tab colors.
- Clarify tab color palette controls with edit-button wording and visible `Tint` labels beside tint-strength sliders.
- Align edit and close actions to the right edge of vertical left/right terminal tabs.

## 1.1.13 - May 19, 2026

### Security

- Serialize selected Obsidian text in the Hermes Python bridge as `selected_text_json` with escaped angle brackets, matching the TypeScript bridge behavior and preventing Markdown fences or XML-like tags in selections from breaking the context boundary.
- Add Python regression tests for both Hermes bridge entrypoints covering triple backticks, `</obsidian_context>`, and fake `<system>` tags while preserving exact raw text through `obsidian_context()`.

### Improvements

- Run Python bridge regression tests in CI.

## 1.1.0 - May 15, 2026

### New

- feat: ARM64 Windows (win32-arm64) binary support - enables plugin on Surface Pro X and ARM64 Windows devices (#62)

### Milestone

- Plugin now available in Obsidian Community Plugin Directory (officially published)

## 0.16.0 - May 11, 2026

### New

- feat: Clickable [[wikilinks]] and obsidian:// URI support

### Improvements

- docs: add line height setting to README

## 0.15.0 - May 7, 2026

### New

- feat: URI protocol handler for directory-specific terminal launch (v0.14.0)
- Add donation link to README
- feat: clickable URLs + lineHeight live updates (fixes #41, #42)

### Improvements

- docs: reorganize features section into logical groups
- ci: auto-add new issues to LOT Feedback Tracker project

## 0.14.0 - May 4, 2026

### Improvements

- docs: add shields.io badges to README
- docs: restyle badges to LeanProductivity brand colors
- docs: per-badge brand colors for issues open/closed
- docs: fix badge color scheme
- revert: badge color scheme changes from PR #31
- docs: finalize badge colors to LP brand spec
- docs: set value bg to black for stars, manifest, downloads
- docs: add Obsidian and License badges
- docs: consolidate issues badges
- docs: refresh badge lineup

## 0.12.4 - April 29, 2026

### New

- feat: keyboard shortcuts for terminal tab navigation (v0.12.4)

## 0.12.3 - April 29, 2026

### Improvements

- Release v0.12.3 - Vitest test framework, code quality fixes, plugin requirements compliance

## 0.12.2 - April 28, 2026

## 0.12.0 - April 28, 2026

## 0.11.0 - April 28, 2026

## 0.9.6 - April 24, 2026

## 0.9.5 - April 24, 2026

## 0.9.4 - April 23, 2026

## 0.9.2 - April 23, 2026

## 0.9.1 - April 22, 2026

## 0.9.0 - April 21, 2026

### New

- Add 8 built-in color schemes + user-editable themes.json

### Improvements

- @FarhadGSRX made their first contribution in https://github.com/dannyshmueli/obsidian-hermes-console/pull/12

## 0.8.0 - April 21, 2026

### Improvements

- @kkugot made their first contribution in https://github.com/dannyshmueli/obsidian-hermes-console/pull/5

### Bug fixes

- Fix emoji rendering and add system theme with terminal color reporting

## 0.7.0 - April 20, 2026

## 0.6.5 - April 15, 2026

### Improvements

- @CHodder5 made their first contribution in https://github.com/dannyshmueli/obsidian-hermes-console/pull/10

### Bug fixes

- fix(zsh): forward .zshenv and .zprofile through ZDOTDIR override

## 0.6.4 - April 15, 2026

## 0.6.3 - April 2, 2026

## 0.6.2 - April 2, 2026

## 0.6.1 - April 1, 2026

## 0.6.0 - April 1, 2026

## 0.5.0 - March 31, 2026

## 0.4.1 - March 26, 2026

## 0.4.0 - March 26, 2026

## v0.3.0 - March 26, 2026

## v0.2.0 - March 25, 2026

## v0.1.1 - March 25, 2026

## v0.1.0 - March 25, 2026

Older releases and more details: [GitHub Releases](https://github.com/dannyshmueli/obsidian-hermes-console/releases)
