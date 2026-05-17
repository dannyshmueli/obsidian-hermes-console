import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

function readRepoFile(path: string): string {
  return readFileSync(resolve(rootDir, path), "utf-8");
}

describe("public plugin identity", () => {
  it("publishes Hermes Console under the hermes-console plugin id", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json")) as {
      id: string;
      name: string;
      description: string;
    };

    expect(manifest.id).toBe("hermes-console");
    expect(manifest.name).toBe("Hermes Console");
    expect(manifest.description).toContain("Hermes Console");
    expect(manifest.description).not.toContain("Hermes Console for Obsidian Plan");
  });

  it("registers only the canonical hermes-console URI protocol", () => {
    const mainSource = readRepoFile("src/main.ts");

    expect(mainSource).toContain('registerObsidianProtocolHandler("hermes-console"');
    expect(mainSource).not.toContain('registerObsidianProtocolHandler("lean-terminal"');
  });

  it("uses hermes-console for public install and URI documentation", () => {
    const installScript = readRepoFile("install.mjs");
    const readme = readRepoFile("README.md");
    const changelog = readRepoFile("CHANGELOG.md");
    const changelogGenerator = readRepoFile("scripts/generate-changelog.mjs");
    const uriDoc = readRepoFile("docs/uri-handler.md");

    expect(installScript).toContain('".obsidian", "plugins", "hermes-console"');
    expect(installScript).toContain('"hermes", "obsidian_context_bridge.js"');
    expect(installScript).not.toContain('".obsidian", "plugins", "lean-terminal"');

    expect(readme).toContain(".obsidian/plugins/hermes-console");
    expect(readme).toContain("obsidian://hermes-console");
    expect(readme).not.toContain("Hermes Console for Obsidian Plan");
    expect(readme).not.toContain("obsidian://lean-terminal");

    expect(uriDoc).toContain("obsidian://hermes-console");
    expect(uriDoc).not.toContain("obsidian://lean-terminal");
    expect(uriDoc).not.toContain("Hermes Console for Obsidian Plan");

    expect(changelog).not.toContain("Hermes Console for Obsidian Plan");
    expect(changelogGenerator).not.toContain("Hermes Console for Obsidian Plan");
  });
});
