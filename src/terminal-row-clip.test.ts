import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
const css = readFileSync(stylesPath, "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `missing CSS rule ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("terminal row clipping", () => {
  it("measures glyphs with a zero letter-spacing baseline", () => {
    const measure = ruleBody(`.terminal-session,
.terminal-session .xterm,
.terminal-session .xterm-char-measure-element,
.terminal-session .xterm-width-cache-measure-container`);
    expect(measure).toContain("letter-spacing: 0;");
    expect(measure).toContain("font-kerning: none;");
    expect(measure).toContain("font-variant-ligatures: none;");
  });

  it("lets row text inherit xterm's own grid letter-spacing", () => {
    const rows = ruleBody(`.terminal-session .xterm-rows > div,
.terminal-session .xterm-rows span`);
    expect(rows).toContain("letter-spacing: inherit;");
    expect(rows).not.toContain("letter-spacing: 0");
  });

  it("does not reveal row overflow", () => {
    const rows = ruleBody(`.terminal-session .xterm-rows > div,
.terminal-session .xterm-rows span`);
    expect(rows).not.toMatch(/overflow\s*:/);
    expect(css).not.toMatch(/\.xterm-rows\s*>\s*div[^{]*\{[^}]*overflow:\s*visible/);
  });
});
