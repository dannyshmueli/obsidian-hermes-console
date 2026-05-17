# URI Handler

Hermes Console for Obsidian Plan keeps the compatible `obsidian://lean-terminal` protocol handler, usable from any note link, dashboard button, or external script:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `cwd` | Open a terminal tab in the given directory (URL-encoded path) | `obsidian://lean-terminal?cwd=%2Fhome%2Fuser%2Fprojects%2Fmy-app` |
| `resume` | Open a fresh terminal tab and run `hermes --resume <session-id>` once the shell is ready (requires Hermes session integration enabled) | `obsidian://lean-terminal?resume=20260517_103803_4b6c9d` |

The `cwd` parameter is useful for dashboards and launchers. In an Obsidian note with Dataview JS or a custom button plugin:

```js
app.workspace.openLinkText("obsidian://lean-terminal?cwd=" + encodeURIComponent("/path/to/project"), "");
```

Or as a plain Markdown link (paths must be URL-encoded):

```markdown
[Open project terminal](obsidian://lean-terminal?cwd=%2Fpath%2Fto%2Fproject)
```

If the terminal panel is already open, the URI opens a new tab in the target directory. If it is closed, a fresh panel opens there.
