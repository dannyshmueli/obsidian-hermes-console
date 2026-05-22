/**
 * Installs the plugin into an Obsidian vault's .obsidian/plugins directory.
 *
 * Usage: node install.mjs [vault-path]
 * Default vault: D:\LOS Test
 */

import { chmodSync, cpSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const vaultPath = process.argv[2] || "D:\\LOS Test";
const pluginDir = join(vaultPath, ".obsidian", "plugins", "hermes-console");

if (!existsSync(join(vaultPath, ".obsidian"))) {
  console.error(`Error: ${vaultPath} does not appear to be an Obsidian vault (no .obsidian folder)`);
  process.exit(1);
}

const srcDir = resolve(import.meta.dirname);

// Create plugin directory
mkdirSync(pluginDir, { recursive: true });

// Copy essential plugin files
const files = ["main.js", "manifest.json", "styles.css"];
for (const file of files) {
  const src = join(srcDir, file);
  if (!existsSync(src)) {
    console.error(`Error: ${file} not found. Run 'npm run build' first.`);
    process.exit(1);
  }
  cpSync(src, join(pluginDir, file));
  console.log(`  Copied ${file}`);
}

const assetDir = join(srcDir, "assets");
if (existsSync(assetDir)) {
  cpSync(assetDir, join(pluginDir, "assets"), { recursive: true });
  console.log("  Copied assets");
}

// Copy Hermes plugin files used by the context bridge.
const hermesPluginDir = join(srcDir, "hermes");
const hermesFiles = ["obsidian_context_bridge.js", "plugin.yaml"];
mkdirSync(join(pluginDir, "hermes"), { recursive: true });
for (const file of hermesFiles) {
  const source = join(hermesPluginDir, file);
  if (!existsSync(source)) {
    console.error(`Error: hermes/${file} not found.`);
    process.exit(1);
  }
  cpSync(source, join(pluginDir, "hermes", file));
  console.log(`  Copied hermes/${file}`);
}

// Copy node-pty (native module needed at runtime)
const nodePtySrc = join(srcDir, "node_modules", "node-pty");
const nodePtyDest = join(pluginDir, "node_modules", "node-pty");

if (existsSync(nodePtySrc)) {
  // Copy lib first, then apply patch immediately (before prebuilds which may be locked)
  mkdirSync(join(nodePtyDest, "lib"), { recursive: true });
  cpSync(join(nodePtySrc, "lib"), join(nodePtyDest, "lib"), { recursive: true });

  // Apply patch right away — if prebuilds copy fails below, the patch is still in place
  const patchSrc = join(srcDir, "patches", "windowsConoutConnection.js");
  if (existsSync(patchSrc)) {
    cpSync(patchSrc, join(nodePtyDest, "lib", "windowsConoutConnection.js"));
    console.log("  Applied ConoutConnection patch (no Worker threads)");
  }

  // Prebuilds, package.json, third_party — may be locked if Obsidian has terminal open
  let binaryWarning = false;
  try {
    cpSync(join(nodePtySrc, "prebuilds"), join(nodePtyDest, "prebuilds"), { recursive: true });
    const spawnHelper = join(nodePtyDest, "prebuilds", "darwin-arm64", "spawn-helper");
    if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755);
  } catch {
    binaryWarning = true;
  }
  try {
    cpSync(join(nodePtySrc, "package.json"), join(nodePtyDest, "package.json"));
  } catch {
    binaryWarning = true;
  }
  const thirdParty = join(nodePtySrc, "third_party");
  if (existsSync(thirdParty)) {
    try {
      cpSync(thirdParty, join(nodePtyDest, "third_party"), { recursive: true });
    } catch {
      binaryWarning = true;
    }
  }

  if (binaryWarning) {
    console.log("  Copied node-pty lib + patch (binaries locked by Obsidian — existing binaries unchanged)");
  } else {
    console.log("  Copied node-pty (prebuilt N-API binaries)");
  }
} else {
  console.error("Error: node_modules/node-pty not found. Run 'npm install' first.");
  process.exit(1);
}

console.log(`\nPlugin installed to: ${pluginDir}`);
console.log("Restart Obsidian and enable the 'Hermes Console' plugin in Settings > Community Plugins.");
