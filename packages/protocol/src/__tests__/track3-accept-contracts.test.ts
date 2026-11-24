import { describe, expect, it } from "vitest";
import {
  AcceptEntryConfigSchema,
  AcceptVerificationReportSchema,
  RosterConfigSchema,
  VerifierReceiptFrontmatterSchema,
  createDefaultBuiltinRosterMetadata,
  parseAndValidateReceipt,
  serializeFrontmatterMarkdown,
} from "../index.js";

describe("Track 3 contracts (B7 accept_entry + Slim B8 + B9 verifier evidence)", () => {
  it("validates multi-process accept_entry service graphs and blocks cycles, duplicates, and escaping cwd", () => {
    const valid = AcceptEntryConfigSchema.parse({
      kind: "http_server",
      prepare_cmd: "pnpm build",
      services: [
        {
          name: "api",
          cmd: "node api.mjs --port {{port}}",
          cwd: "apps/api",
          needs_port: true,
          depends_on: [],
          ready: { kind: "http", path: "/health" },
        },
        {
          name: "web",
          cmd: "node web.mjs --api {{ports.api}} --port {{port}}",
          cwd: "apps/web",
          needs_port: true,
          primary: true,
          depends_on: ["api"],
          ready: { kind: "http", path: "/" },
        },
      ],
      observe_http: true,
      required_capability: "browser",
    });
    expect(valid.kind).toBe("http_server");

    expect(() =>
      AcceptEntryConfigSchema.parse({
        kind: "http_server",
        services: [
          { name: "a", cmd: "node a.js", depends_on: ["b"] },
          { name: "b", cmd: "node b.js", depends_on: ["a"] },
        ],
      }),
    ).toThrow(/Cyclic service dependency/);

    expect(() =>
      AcceptEntryConfigSchema.parse({
        kind: "http_server",
        services: [
          { name: "api", cmd: "node a.js" },
          { name: "api", cmd: "node b.js" },
        ],
      }),
    ).toThrow(/Duplicate accept service name/);

    expect(() =>
      AcceptEntryConfigSchema.parse({
        kind: "http_server",
        services: [{ name: "web", cmd: "node w.js", cwd: "../outside" }],
      }),
    ).toThrow(/relative path inside the workspace/);
  });

  it("enforces verifier_capabilities on verifier roster entry with honest cli default", () => {
    const seed = createDefaultBuiltinRosterMetadata();
    expect(seed.verifier.verifier_capabilities).toEqual(["cli"]);

    const parsed = RosterConfigSchema.parse({
      schema_version: 2,
      roster: {
        ...seed,
        verifier: {
          ...seed.verifier,
          enabled: true,
          primary: { provider: "codex", model: "gpt-5.3" },
          verifier_capabilities: ["cli", "browser"],
        },
      },
    });
    expect(parsed.roster.verifier?.verifier_capabilities).toEqual(["cli", "browser"]);

    expect(() =>
      RosterConfigSchema.parse({
        schema_version: 2,
        roster: {
          ...seed,
          verifier: {
            ...seed.verifier,
            verifier_capabilities: [],
          },
        },
      }),
    ).toThrow();
  });

  it("enforces VerifierReceiptFrontmatter pass/fail mutual exclusion and validates AcceptVerificationReport", () => {
    expect(() =>
      VerifierReceiptFrontmatterSchema.parse({
        run_id: "run-1",
        contract_version: 1,
        verified_ref: "HEAD",
        verdict: "pass",
        passed_scenarios: 1,
        failed_scenarios: 1,
      }),
    ).toThrow(/mutually exclusive/);

    const badScenarioMd = serializeFrontmatterMarkdown(
      {
        run_id: "run-1",
        contract_version: 1,
        verified_ref: "HEAD",
        verdict: "pass",
        entry_mode: "browser",
        passed_scenarios: 1,
        failed_scenarios: 0,
        scenarios: [{ name: "login", status: "fail", note: "401" }],
      },
      "## 验收场景明细\n- login failed\n",
    );
    const badRes = parseAndValidateReceipt("verifier", badScenarioMd);
    expect(badRes.ok).toBe(false);

    const report = AcceptVerificationReportSchema.parse({
      run_id: "run-1",
      contract_version: 1,
      checked_at: new Date().toISOString(),
      entry_kind: "http_server",
      entry_mode: "browser",
      verdict: "blocked",
      gate_ok: false,
      rejection_reasons: ["no_real_traffic_observed", "missing_visual_evidence"],
    });
    expect(report.gate_ok).toBe(false);
    expect(report.rejection_reasons).toEqual([
      "no_real_traffic_observed",
      "missing_visual_evidence",
    ]);
  });
});
