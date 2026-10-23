/**
 * Shared text hashing for Obsidian context payloads.
 *
 * Kept in its own module so both the Markdown capture path and the PDF capture
 * path can use it without creating a circular import between them.
 *
 * Args:
 *   text: the selected text to fingerprint.
 *
 * Usage:
 *   hashText("hello") // => "4f9f2cab5b8b5f0e"
 *
 * Demo (real output for the empty string, 32 hex chars, two FNV-1a passes):
 *   hashText("") === "811c9dc54e5d3a9e"
 */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${toHex32(h1)}${toHex32(h2)}`;
}

function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
