import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { shouldRunStartupCommandForTab } from "./startup-command";

describe("DEFAULT_SETTINGS", () => {
  it("keeps a high scrollback configured for long Hermes sessions", () => {
    expect(DEFAULT_SETTINGS.scrollback).toBeGreaterThanOrEqual(500_000);
  });

  it("starts fresh new tabs in Hermes by default", () => {
    expect(DEFAULT_SETTINGS.startupCommand).toBe("hermes");
  });

  it("defaults to the Hermes bot chat icon", () => {
    expect(DEFAULT_SETTINGS.ribbonIcon).toBe("bot-message-square");
  });

  it("defaults Hermes session integration on", () => {
    expect(DEFAULT_SETTINGS.enableClaudeIntegration).toBe(true);
    expect(DEFAULT_SETTINGS.claudeSessionsMax).toBeGreaterThan(0);
  });

  it("defaults Obsidian context sharing off until the user enables it", () => {
    expect(DEFAULT_SETTINGS.sendObsidianContextToHermes).toBe(false);
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
