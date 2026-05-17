import type TerminalPlugin from "./main";
import type { CreateTabOpts } from "./terminal-tab-manager";
import { shouldRunStartupCommandForTab } from "./startup-command";
import type { TerminalView } from "./terminal-view";
import { VIEW_TYPE_TERMINAL } from "./constants";

/**
 * Open a tab in the existing terminal view, or open a fresh view with a
 * transient state hint that preserves startup-command intent without making it
 * part of workspace persistence.
 */
export async function openTabOrView(plugin: TerminalPlugin, opts: CreateTabOpts): Promise<void> {
  const existingLeaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
  if (existingLeaves.length > 0) {
    const view = existingLeaves[0].view as TerminalView;
    const manager = view.getTabManager();
    if (manager) {
      manager.createTab(opts);
      void plugin.app.workspace.revealLeaf(existingLeaves[0]);
      return;
    }
  }

  const leaf =
    plugin.settings.defaultLocation === "right"
      ? plugin.app.workspace.getRightLeaf(false)
      : plugin.app.workspace.getLeaf("split", "horizontal");
  if (!leaf) return;

  await leaf.setViewState({
    type: VIEW_TYPE_TERMINAL,
    active: true,
    state: {
      tabs: [{
        name: opts.name,
        color: opts.color ?? "",
        cwd: opts.cwd,
        bufferSerial: opts.bufferSerial,
        resumeCommand: opts.resumeCommand,
        pinned: opts.pinned,
      }],
      activeIndex: 0,
      runStartupCommand: shouldRunStartupCommandForTab(opts),
    },
  });
  void plugin.app.workspace.revealLeaf(leaf);
}
