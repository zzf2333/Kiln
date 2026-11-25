import { describe, expect, it } from "vitest";
import {
  formatSelectedOptionsReply,
  normalizeStructuredQuestions,
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

  it("parses Markdown comparison tables and heading-style options while ignoring ordinary tables", () => {
    const ordinaryTable = [
      "| 模块 | 职责 |",
      "| :--- | :--- |",
      "| store | SQLite 派生索引 |",
      "| gate | 范围检查 |",
    ].join("\n");
    expect(parseClarificationQuestions(ordinaryTable)).toEqual([]);

    const decisionTable = [
      "### 3. 下一步怎么处理？（建议选方案 A）",
      "",
      "| 方案 | 做法 | 收益与代价 |",
      "| :--- | :--- | :--- |",
      "| **A. 更新契约放宽取证规则 → 退回重扫（推荐）** | 用 `wb_plan` 更新契约 v2：<br>1. 放开安装回执读取 | **收益**：识别真实残留。<br>**代价**：重跑一轮。 |",
      "| **B. 不改契约，直接送审** | 跳过清单补全 | 最快结束，但不隔离任何目录。 |",
      "| **C. 取消并重开任务卡** | 取消 `t-101` 重建 | 可重设编号，代价是丢弃当前记录。 |",
    ].join("\n");

    const parsedTable = parseClarificationQuestions(decisionTable);
    expect(parsedTable).toHaveLength(1);
    expect(parsedTable[0]!.number).toBe("3");
    expect(parsedTable[0]!.title).toContain("下一步怎么处理？");
    expect(
      parsedTable[0]!.options.map((o) => ({
        key: o.key,
        label: o.label,
        recommended: o.recommended,
      })),
    ).toEqual([
      { key: "A", label: "更新契约放宽取证规则 → 退回重扫", recommended: true },
      { key: "B", label: "不改契约，直接送审", recommended: false },
      { key: "C", label: "取消并重开任务卡", recommended: false },
    ]);
    expect(parsedTable[0]!.options[0]!.detail).toContain("收益：识别真实残留");

    const unnumberedTable = [
      "请从下表中选择清理策略：",
      "",
      "| 选项 | 说明 |",
      "| :--- | :--- |",
      "| A（推荐）：安全隔离 | 先移入隔离区 |",
      "| B：直接删除 | 不可恢复 |",
    ].join("\n");
    const parsedUnnumbered = parseClarificationQuestions(unnumberedTable);
    expect(parsedUnnumbered).toHaveLength(1);
    expect(parsedUnnumbered[0]!.number).toBe("1");
    expect(parsedUnnumbered[0]!.title).toBe("请从下表中选择清理策略");
    expect(parsedUnnumbered[0]!.options.map((o) => o.key)).toEqual(["A", "B"]);

    const headingOptions = [
      "1. 部署策略",
      "### 方案 A（推荐）：灰度发布",
      "### 方案 B：全量发布",
    ].join("\n");
    const parsedHeadings = parseClarificationQuestions(headingOptions);
    expect(parsedHeadings).toHaveLength(1);
    expect(parsedHeadings[0]!.options.map((o) => o.key)).toEqual(["A", "B"]);
    expect(parsedHeadings[0]!.options[0]!.recommended).toBe(true);
  });

  it("normalizes structured ChatOptionQuestion payloads and formats multi-select replies", () => {
    const normalized = normalizeStructuredQuestions([
      {
        number: "1",
        title: "要补充保护哪些目录？",
        multi_select: true,
        options: [
          { key: "a", label: "保留 Raycast 插件", recommended: true },
          { key: "B", label: "保留 OrbStack 数据", detail: "包含容器镜像" },
          { key: "C", label: "其他自定义应用", needs_input: true },
        ],
      },
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.multiSelect).toBe(true);
    expect(normalized[0]!.options.map((o) => o.key)).toEqual(["A", "B", "C"]);
    expect(normalized[0]!.options[2]!.needsInput).toBe(true);

    const formatted = formatSelectedOptionsReply(
      normalized,
      { "1": ["A", "C"] },
      { "1": "iTerm2" },
    );
    expect(formatted).toBe(
      "1. 要补充保护哪些目录？：选 A、C（保留 Raycast 插件；其他自定义应用），补充：iTerm2",
    );
  });
});
