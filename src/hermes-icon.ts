export const HERMES_ICON_ID = "hermes-caduceus-wing";
export const HERMES_MARK_ICON_ID = "hermes-caduceus-mark";

/**
 * Sidebar/ribbon icon: intentionally low detail.
 * At Obsidian's 16-24px ribbon size, feathers and twin snakes turn into mush.
 * This keeps only three readable Hermes cues: staff, wing, serpent curve.
 */
export const HERMES_ICON_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 4v16" />
  <path d="M9.7 5.2h4.6" />
  <path d="M12 4.2a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Z" />
  <path d="M12 8.2c-4.2 1.7-4.2 4.6 0 6.2 4.2 1.6 4.2 4.2 0 5.6" />
  <path d="M10.4 8.6 4.8 5.9" />
  <path d="M4.8 5.9c1.7-.3 3.5 0 5.4 1.3" />
  <path d="M5.8 8.2c1.3-.1 2.5.1 3.7.8" />
</svg>`;

/**
 * Header/brand mark: richer, still monochrome, used where it has room.
 */
export const HERMES_MARK_ICON_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 3v18" />
  <path d="M9.2 4.4h5.6" />
  <path d="M10 6.4h4" />
  <path d="M12 3.1c.9 0 1.6.7 1.6 1.6S12.9 6.3 12 6.3s-1.6-.7-1.6-1.6S11.1 3.1 12 3.1Z" />
  <path d="M11.9 8.1c-3-.1-4.6 1.1-4.6 2.7 0 1.2 1.1 1.9 2.7 2.7 1.6.8 2.2 1.6 2.2 2.8 0 1.7-1.5 3-3.9 3.5" />
  <path d="M12.1 8.1c3-.1 4.6 1.1 4.6 2.7 0 1.2-1.1 1.9-2.7 2.7-1.6.8-2.2 1.6-2.2 2.8 0 1.7 1.5 3 3.9 3.5" />
  <path d="M10.1 8.4 4.1 5.5" />
  <path d="M4.1 5.5c1.6-.5 3.4-.3 5.4.9" />
  <path d="M5.1 7.5c1.3-.3 2.7-.1 4.2.8" />
  <path d="M13.9 8.4 19.9 5.5" />
  <path d="M19.9 5.5c-1.6-.5-3.4-.3-5.4.9" />
  <path d="M18.9 7.5c-1.3-.3-2.7-.1-4.2.8" />
  <path d="M15.1 13.8c2.3 1.1 3.5 3 3.7 5.9" />
  <path d="M18.6 14.3c-.8 2.6-2.3 4.7-4.7 6.1" />
</svg>`;
