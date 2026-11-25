import { describe, expect, it } from "vitest";
import {
  formatSelectedOptionsReply,
  parseClarificationQuestions,
} from "../state/clarification-parser";

describe("clarification-parser", () => {
  it("parses multi-question A/B/C clarification blocks with recommendations and trade-off notes", () => {
    const sample = [
      "因为清理 `Library` 涉及误删配置/CLI 工具风险，请先拍板以下 3 个边界问题：",
      "",
      "1. **清理范围（查哪些应用、哪些目录）**",
      "A（推荐）：全量扫描当前用户 `~/Library`，交叉比对 `/Applications`、`~/Applications`、`/System/Applications` 与活跃进程，自动找出疑似已卸载应用的残余清单（无需 `sudo`，风险可控）。",
      "B：只清理您指定的某几个已删 App（若选此项，请直接列出 App 名称，范围更精准、噪音为零）。",
      "C：在 A 或 B 基础上，额外扫描系统级 `/Library`（如 `/Library/Application Support`）。收益是清理更彻底；代价是需要 `sudo` 提权，误伤概率更高。",
      "",
      "**2. 清理处置方式（可逆性）**",
      "**A（推荐）**：移入本机可恢复隔离区（落盘在 `/Users/saonian/.local/share/kiln-app-cleanup/quarantine/<时间戳>/`）并附带一键恢复脚本。",
      "收益：一旦发现误判，可一键无损还原。",
      "代价：执行完不会立刻腾出磁盘空间。",
      "**B**：审批清单后直接 `rm -rf` 永久删除。",
      "",
      "3. 高风险数据目录如何纳入本次清单",
      "- A（推荐）：一并扫描并按风险分级展示。",
      "- B：首轮保守模式，仅清理纯缓存与日志。",
    ].join("\n");

    const parsed = parseClarificationQuestions(sample);
    expect(parsed).toHaveLength(3);

    expect(parsed[0]!.number).toBe("1");
    expect(parsed[0]!.title).toBe("清理范围（查哪些应用、哪些目录）");
    expect(parsed[0]!.options.map((o) => o.key)).toEqual(["A", "B", "C"]);
    expect(parsed[0]!.options[0]!.recommended).toBe(true);
    expect(parsed[0]!.options[1]!.needsInput).toBe(true);
    expect(parsed[0]!.options[2]!.recommended).toBe(false);

    expect(parsed[1]!.options).toHaveLength(2);
    expect(parsed[1]!.options[0]!.recommended).toBe(true);
    expect(parsed[1]!.options[0]!.detail).toContain("收益：");
    expect(parsed[1]!.options[0]!.detail).toContain("代价：");

    expect(parsed[2]!.options).toHaveLength(2);
    expect(parsed[2]!.options[0]!.recommended).toBe(true);

    const formatted = formatSelectedOptionsReply(
      parsed,
      { "1": "B", "2": "A", "3": "A" },
      { "1": "Docker Desktop" },
    );
    expect(formatted).toContain("1. 清理范围（查哪些应用、哪些目录）：选 B");
    expect(formatted).toContain("补充：Docker Desktop");
    expect(formatted).toContain("2. 清理处置方式（可逆性）：选 A");
    expect(formatted).toContain("3. 高风险数据目录如何纳入本次清单：选 A");
  });

  it("ignores fenced code blocks and avoids false positives on normal numbered lists", () => {
    const plain = [
      "1. 修改 packages/protocol 契约",
      "2. 在 kernel 运行单测验证",
      "3. 打开桌面客户端验收",
      "",
      "```markdown",
      "1. 示例",
      "A：不应该解析代码块内的选项",
      "B：不应该触发",
      "```",
    ].join("\n");

    expect(parseClarificationQuestions(plain)).toEqual([]);
  });

  it("supports 方案/选项/Option prefixes and does not misparse analytical section headers", () => {
    const analyticalOnly = [
      "结论先行：当前卡在预算阈值与空清单。",
      "1. 表层卡点：为什么停在 max_tokens_exceeded？",
      "已确认事实：缓存命中占了 278.3 万。",
      "2. 实质问题：为什么 staged/manifest.json 为空？",
      "已确认事实：报告里其实有 281 项。",
    ].join("\n");
    expect(parseClarificationQuestions(analyticalOnly)).toEqual([]);

    const mixedWithPicker = [
      analyticalOnly,
      "",
      "请直接选择后续处理方案：",
      "1. 下一步处理方案",
      "方案 A（推荐）：放宽 max_tokens 到 800k 并退回实施阶段补全清单",
      "选项 B：直接按现有结果转入审查",
      "Option C：取消任务",
    ].join("\n");

    const parsed = parseClarificationQuestions(mixedWithPicker);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.number).toBe("1");
    expect(parsed[0]!.title).toBe("下一步处理方案");
    expect(
      parsed[0]!.options.map((o) => ({ key: o.key, label: o.label, recommended: o.recommended })),
    ).toEqual([
      { key: "A", label: "放宽 max_tokens 到 800k 并退回实施阶段补全清单", recommended: true },
      { key: "B", label: "直接按现有结果转入审查", recommended: false },
      { key: "C", label: "取消任务", recommended: false },
    ]);
  });
});
