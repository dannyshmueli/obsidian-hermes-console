export const HERMES_ICON_ID = "hermes-caduceus-wing";
export const HERMES_SETTINGS_ICON_ID = "hermes-settings-sliders";

/**
 * Image-gen based Hermes wings.
 * Source concept: /Users/danny/.hermes/cache/images/openai_codex_gpt-image-2-high_20260517_145621_78c77a5a.png
 * Filled silhouette with simple feather cuts so it reads in Obsidian's tiny ribbon.
 */
export const HERMES_ICON_SVG = `
<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M11.25 19.8C9.9 16 6.95 15.55 4.65 13.65 2.45 11.85 1.55 8.85 1.35 5.45c3.05 2.8 6.15 4.55 8.45 6.75 1.55 1.5 2.1 3.45 1.45 7.6ZM4.05 9.35c2.15 1.05 4.05 2.05 5.9 3.75-2.35-.25-4.1-.9-5.9-3.75Zm1.55 4.15c1.55.75 3.05 1.25 4.45 1.55-1.85.55-3.25.1-4.45-1.55Z" />
  <path fill-rule="evenodd" clip-rule="evenodd" d="M12.75 19.8c1.35-3.8 4.3-4.25 6.6-6.15 2.2-1.8 3.1-4.8 3.3-8.2-3.05 2.8-6.15 4.55-8.45 6.75-1.55 1.5-2.1 3.45-1.45 7.6Zm7.2-10.45c-2.15 1.05-4.05 2.05-5.9 3.75 2.35-.25 4.1-.9 5.9-3.75Zm-1.55 4.15c-1.55.75-3.05 1.25-4.45 1.55 1.85.55 3.25.1 4.45-1.55Z" />
</svg>`;

/**
 * Settings icon: custom oversized sliders.
 * Lucide sliders look tiny because most of the 24px box is empty. This uses the
 * full box so it remains legible in the header button.
 */
export const HERMES_SETTINGS_ICON_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 7h16" />
  <path d="M4 17h16" />
  <path d="M8.5 4.5v5" />
  <path d="M15.5 14.5v5" />
</svg>`;
