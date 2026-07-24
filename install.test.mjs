import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const installScript = fileURLToPath(new URL("./install.mjs", import.meta.url));
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "hermes-console-install-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runInstaller(args = [], environment = {}) {
  const env = { ...process.env, ...environment };
  delete env.HERMES_CONSOLE_VAULT;

  if (environment.HERMES_CONSOLE_VAULT !== undefined) {
    env.HERMES_CONSOLE_VAULT = environment.HERMES_CONSOLE_VAULT;
  }

  return spawnSync(process.execPath, [installScript, ...args], {
    encoding: "utf8",
    env,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("install.mjs vault path", () => {
  test("requires an explicit vault path when the environment fallback is unset", () => {
    const result = runInstaller();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error: an Obsidian vault path is required.");
    expect(result.stderr).toContain("Usage: node install.mjs <vault-path>");
    expect(result.stderr).toContain("HERMES_CONSOLE_VAULT");
  });

  test("uses HERMES_CONSOLE_VAULT as a fallback", () => {
    const vaultPath = temporaryDirectory();
    const result = runInstaller([], { HERMES_CONSOLE_VAULT: vaultPath });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Error: ${vaultPath} does not appear to be an Obsidian vault`,
    );
    expect(result.stderr).not.toContain("an Obsidian vault path is required");
  });

  test("prefers the command-line path over HERMES_CONSOLE_VAULT", () => {
    const cliVaultPath = temporaryDirectory();
    const environmentVaultPath = temporaryDirectory();
    const result = runInstaller([cliVaultPath], {
      HERMES_CONSOLE_VAULT: environmentVaultPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Error: ${cliVaultPath} does not appear`);
    expect(result.stderr).not.toContain(environmentVaultPath);
  });
});
