import { describe, expect, it } from "vitest";

import { countWords } from "./text-stats";

/**
 * The header prints this number for PDF selections instead of a character
 * count, so the cases here are the ones a reader actually produces: Chinese
 * prose (which a whitespace split would report as one word), mixed
 * Chinese/Latin, and the LaTeX fragments this vault's thesis PDFs are full of.
 */
describe("countWords", () => {
  it("counts nothing for empty or punctuation-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
    expect(countWords("…——（）")).toBe(0);
  });

  it("counts Latin words", () => {
    expect(countWords("Hello world")).toBe(2);
    expect(countWords("PID")).toBe(1);
  });

  it("counts each CJK character as one word (字数, not whitespace tokens)", () => {
    expect(countWords("焊缝打磨实验验证与结果分析")).toBe(13);
    expect(countWords("焊缝打磨，实验验证。")).toBe(8); // full-width punctuation counts zero
  });

  it("counts a whole Chinese paragraph, not one token", () => {
    const paragraph =
      "传统工业装配任务通常依赖预定义轨迹完成，对装配环境和工件位姿具有较强依赖性。" +
      "当工件存在位置或姿态偏差时，易出现卡滞、接触力过大等问题，影响装配成功率和系统安全性。";
    // A whitespace split reports 1 for this; the header must not.
    expect(countWords(paragraph)).toBeGreaterThan(50);
  });

  it("adds Latin/number runs to the CJK count", () => {
    expect(countWords("5.3.1 基于位置的阻抗控制恒力打磨")).toBe(16); // 13 CJK + 5, 3, 1
    expect(countWords("论文765.3.1")).toBe(5); // 2 CJK + 765, 3, 1
    expect(countWords("第 3 章 视觉引导与力觉搜索协同")).toBe(14); // 13 CJK + 3
    expect(countWords("PID 控制器的 gain=0.8")).toBe(8); // 4 CJK + PID, gain, 0, 8
  });

  it("treats a LaTeX fragment as its symbol runs", () => {
    expect(countWords("$S = \\mathrm{diag}(1,1,0,1,1,1)$")).toBe(9); // S, mathrm, diag + six 1/0 runs
  });

  it("counts kana and hangul like Han", () => {
    expect(countWords("ひらがな")).toBe(4);
    expect(countWords("한글")).toBe(2);
  });
});
