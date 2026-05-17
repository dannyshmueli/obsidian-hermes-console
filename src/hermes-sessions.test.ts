import { describe, expect, it } from "vitest";
import { parseHermesSessionsList } from "./hermes-sessions";

describe("parseHermesSessionsList", () => {
  it("parses Hermes CLI session list output", () => {
    const output = `Title                            Preview                                  Last Active   ID
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
Hermes Lucide Icon Choice        which icon from https://lucide.dev/ico   2h ago        20260517_080000_908d23
Obsidian Hermes Context Implem                                            just now      20260517_103803_4b6c9d
—                                Reply exactly: smoke-ok                  2d ago        bg_111541_99adb8
`;

    expect(parseHermesSessionsList(output)).toEqual([
      {
        sessionId: "20260517_080000_908d23",
        title: "Hermes Lucide Icon Choice",
        preview: "which icon from https://lucide.dev/ico",
        lastActive: "2h ago",
      },
      {
        sessionId: "20260517_103803_4b6c9d",
        title: "Obsidian Hermes Context Implem",
        preview: "",
        lastActive: "just now",
      },
      {
        sessionId: "bg_111541_99adb8",
        title: "—",
        preview: "Reply exactly: smoke-ok",
        lastActive: "2d ago",
      },
    ]);
  });
});
