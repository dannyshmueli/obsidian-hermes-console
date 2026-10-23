/**
 * Selection size for the console header, in words rather than characters.
 *
 * The bridge budgets in characters (`INLINE_SELECTION_LIMIT`, the preview caps)
 * because that is what the host counts, but "295 chars" reads oddly for prose -
 * readers think in words, and that is what the header is for.
 *
 * A whitespace split is not a word count for CJK text: a whole Chinese
 * paragraph is a single whitespace token, so it would read "1". This follows
 * the count Chinese word processors report for 字数: every CJK character counts
 * once, every run of Latin letters/digits counts once, punctuation counts zero.
 *
 * Args:
 *   text: the selected text (may be empty).
 *
 * Usage:
 *   countWords("Hello world") // => 2
 *
 * Demo (measured, real inputs from this vault):
 *   countWords("焊缝打磨实验验证与结果分析")       // => 13 (13 CJK, no runs)
 *   countWords("5.3.1 基于位置的阻抗控制恒力打磨")  // => 16 (13 CJK + 3 numbers)
 *   countWords("")                               // => 0
 */
export function countWords(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = "";
  for (const character of text) {
    if (CJK_CHARACTER.test(character)) cjk += 1;
    else rest += character;
  }
  return cjk + (rest.match(ALNUM_RUN)?.length ?? 0);
}

/** One CJK character = one word, the way 字数 is counted for Chinese. */
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A run of Latin letters or digits = one word. Punctuation splits runs, so
 * `gain=0.8` counts three (`gain`, `0`, `8`) and `PID` counts one.
 */
const ALNUM_RUN = /[\p{L}\p{N}]+/gu;
