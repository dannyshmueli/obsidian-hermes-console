import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeTerminalPluginSettings } from "./settings";
import { HERMES_ICON_ID } from "./hermes-icon";
import { shouldRunStartupCommandForTab } from "./startup-command";

describe("DEFAULT_SETTINGS", () => {
  it("keeps a high scrollback configured for long Hermes sessions", () => {
    expect(DEFAULT_SETTINGS.scrollback).toBeGreaterThanOrEqual(500_000);
  });

  it("starts fresh new tabs in Hermes by default", () => {
    expect(DEFAULT_SETTINGS.startupCommand).toBe("hermes");
  });

  it("defaults to the custom Hermes half-wing icon", () => {
    expect(DEFAULT_SETTINGS.ribbonIcon).toBe(HERMES_ICON_ID);
  });

  it("defaults Hermes session integration on", () => {
    expect(DEFAULT_SETTINGS.hermesSessionIntegration).toBe(true);
    expect(DEFAULT_SETTINGS.hermesSessionsMax).toBeGreaterThan(0);
  });

  it("migrates legacy Claude-named session settings to Hermes names", () => {
    const { settings, migratedLegacySettings } = normalizeTerminalPluginSettings({
      enableClaudeIntegration: false,
      claudeSessionsMax: 7,
    });

    expect(migratedLegacySettings).toBe(true);
    expect(settings.hermesSessionIntegration).toBe(false);
    expect(settings.hermesSessionsMax).toBe(7);
    expect(settings).not.toHaveProperty("enableClaudeIntegration");
    expect(settings).not.toHaveProperty("claudeSessionsMax");
  });

  it("keeps Hermes-named settings when both current and legacy keys exist", () => {
    const { settings, migratedLegacySettings } = normalizeTerminalPluginSettings({
      hermesSessionIntegration: true,
      hermesSessionsMax: 9,
      enableClaudeIntegration: false,
      claudeSessionsMax: 3,
    });

    expect(migratedLegacySettings).toBe(true);
    expect(settings.hermesSessionIntegration).toBe(true);
    expect(settings.hermesSessionsMax).toBe(9);
  });

  it("opens new terminals in the right sidebar by default", () => {
    expect(DEFAULT_SETTINGS.defaultLocation).toBe("right");
  });

  it("does not include the removed global context-sharing setting in defaults", () => {
    const removedGlobalContextSetting = ["sendObsidianContext", "ToHermes"].join("");

    expect(DEFAULT_SETTINGS).not.toHaveProperty(removedGlobalContextSetting);
  });

  it("ignores old saved global context-sharing values", () => {
    const removedGlobalContextSetting = ["sendObsidianContext", "ToHermes"].join("");
    const { settings, migratedLegacySettings } = normalizeTerminalPluginSettings({
      [removedGlobalContextSetting]: true,
    });

    expect(migratedLegacySettings).toBe(false);
    expect(settings).not.toHaveProperty(removedGlobalContextSetting);
  });

  it("notifies on background Hermes completion by default", () => {
    expect(DEFAULT_SETTINGS.notifyOnHermesIdleInBackground).toBe(true);
  });

  it("uses a wider persisted vertical tab bar by default", () => {
    expect(DEFAULT_SETTINGS.verticalTabBarWidth).toBeGreaterThanOrEqual(200);
  });

  it("clamps saved vertical tab bar width into supported bounds", () => {
    expect(normalizeTerminalPluginSettings({ verticalTabBarWidth: 80 }).settings.verticalTabBarWidth).toBe(132);
    expect(normalizeTerminalPluginSettings({ verticalTabBarWidth: 999 }).settings.verticalTabBarWidth).toBe(360);
    expect(normalizeTerminalPluginSettings({ verticalTabBarWidth: 243.6 }).settings.verticalTabBarWidth).toBe(244);
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

  it("defaults lazy start off so existing behavior is unchanged", () => {
    expect(DEFAULT_SETTINGS.startupOnFirstKey).toBe(false);
  });
});
