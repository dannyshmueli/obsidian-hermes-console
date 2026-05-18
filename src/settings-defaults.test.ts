import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { HERMES_ICON_ID } from "./hermes-icon";
import { shouldRunStartupCommandForTab } from "./startup-command";

describe("DEFAULT_SETTINGS", () => {
  it("keeps a high scrollback configured for long Hermes sessions", () => {
    expect(DEFAULT_SETTINGS.scrollback).toBeGreaterThanOrEqual(500_000);
  });

  it("starts fresh new tabs in Hermes by default", () => {
    expect(DEFAULT_SETTINGS.startupCommand).toBe("hermes");
  });

  it("defaults to the custom Hermes caduceus wing icon", () => {
    expect(DEFAULT_SETTINGS.ribbonIcon).toBe(HERMES_ICON_ID);
  });

  it("defaults Hermes session integration on", () => {
    expect(DEFAULT_SETTINGS.enableClaudeIntegration).toBe(true);
    expect(DEFAULT_SETTINGS.claudeSessionsMax).toBeGreaterThan(0);
  });

  it("opens new terminals in the right sidebar by default", () => {
    expect(DEFAULT_SETTINGS.defaultLocation).toBe("right");
  });

  it("defaults Obsidian context sharing on for Hermes turns", () => {
    expect(DEFAULT_SETTINGS.sendObsidianContextToHermes).toBe(true);
  });

  it("notifies on background Hermes completion by default", () => {
    expect(DEFAULT_SETTINGS.notifyOnHermesIdleInBackground).toBe(true);
  });
});

describe("startup command gating", () => {
  it("only runs for fresh tabs", () => {
    expect(shouldRunStartupCommandForTab()).toBe(true);
    expect(shouldRunStartupCommandForTab({ cwd: "/tmp/project" })).toBe(true);
    expect(shouldRunStartupCommandForTab({ restored: true })).toBe(false);
    expect(shouldRunStartupCommandForTab({ bufferSerial: "" })).toBe(false);
    expect(shouldRunStartupCommandForTab({ bufferSerial: "previous output" })).toBe(false);
    expect(shouldRunStartupCommandForTab({ resumeCommand: "hermes --resume 20260517_103803_4b6c9d" })).toBe(false);
  });
});
