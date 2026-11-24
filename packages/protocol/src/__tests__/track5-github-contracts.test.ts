import { describe, expect, it } from "vitest";
import {
  DraftCardSchema,
  GithubPrFeedbackSnapshotSchema,
  ImportGithubIssueRequestSchema,
  PrFeedbackReworkRequestSchema,
  TaskCardSchema,
  TaskExternalRefSchema,
} from "../index.js";

describe("Track 5 [B11] GitHub Issue & PR feedback protocol contracts", () => {
  it("validates TaskExternalRef on DraftCard and TaskCard", () => {
    const extRef = TaskExternalRefSchema.parse({
      provider: "github",
      repo: "zzf2333/Kiln",
      issue_number: 42,
      issue_url: "https://github.com/zzf2333/Kiln/issues/42",
      pr_number: 88,
      pr_url: "https://github.com/zzf2333/Kiln/pull/88",
      pr_branch: "kiln/t-042",
      last_synced_at: "2026-11-24T04:00:00Z",
    });
    expect(extRef.provider).toBe("github");

    const draft = DraftCardSchema.parse({
      schema_version: 1,
      id: "dr-gh01",
      title: "[GH #42] Fix bridge",
      space: "kiln",
      external_ref: extRef,
      created_at: "2026-11-24T04:00:00Z",
      updated_at: "2026-11-24T04:00:00Z",
    });
    expect(draft.external_ref?.issue_number).toBe(42);

    const card = TaskCardSchema.parse({
      schema_version: 1,
      id: "t-042",
      title: "Fix bridge",
      space: "kiln",
      priority: "P2",
      track: "L2",
      workspace_mode: "git_worktree",
      parent: null,
      depends_on: [],
      contract_version: 1,
      contract: {
        goal: "Fix bridge",
        end: "Done",
        accept_cmd: "echo ok",
        accept_files_hash: `sha256:${"a".repeat(64)}`,
        scope: ["src/index.ts"],
        deliver: { mode: "manual", cmd: null },
        human_accept: false,
        external_actions: "ask",
      },
      limits: {
        retries_per_stage: 2,
        review_rounds: 2,
        advisor_calls: 1,
        max_tokens: 120000,
      },
      external_ref: extRef,
      created_at: "2026-11-24T04:00:00Z",
      updated_at: "2026-11-24T04:00:00Z",
    });
    expect(card.external_ref?.pr_number).toBe(88);
  });

  it("validates ImportGithubIssueRequest and GithubPrFeedbackSnapshot", () => {
    const req = ImportGithubIssueRequestSchema.parse({
      space: "kiln",
      issue: "#42",
    });
    expect(req.issue).toBe("#42");

    const snapshot = GithubPrFeedbackSnapshotSchema.parse({
      repo: "zzf2333/Kiln",
      number: 88,
      url: "https://github.com/zzf2333/Kiln/pull/88",
      title: "feat: fix bridge",
      state: "OPEN",
      head_branch: "kiln/t-042",
      base_branch: "main",
      mergeable: "MERGEABLE",
      fetched_at: "2026-11-24T04:10:00Z",
      checks: [
        {
          name: "ci / test",
          status: "COMPLETED",
          conclusion: "FAILURE",
          details_url: "https://github.com/zzf2333/Kiln/actions/runs/1",
        },
      ],
      comments: [
        {
          id: "c-1",
          kind: "review",
          author: "alice",
          body: "Please handle empty input",
          created_at: "2026-11-24T04:05:00Z",
          state: "CHANGES_REQUESTED",
        },
      ],
    });
    expect(snapshot.checks[0]?.conclusion).toBe("FAILURE");
    expect(snapshot.comments[0]?.kind).toBe("review");
    expect(snapshot.comments[0]?.state).toBe("CHANGES_REQUESTED");
  });

  it("enforces at least one check, comment, or extra_note on PrFeedbackReworkRequest", () => {
    expect(() => PrFeedbackReworkRequestSchema.parse({})).toThrow();
    expect(
      PrFeedbackReworkRequestSchema.parse({
        failed_check_names: ["ci / test"],
      }).failed_check_names,
    ).toEqual(["ci / test"]);
    expect(
      PrFeedbackReworkRequestSchema.parse({
        comment_ids: ["c-1"],
      }).comment_ids,
    ).toEqual(["c-1"]);
    expect(
      PrFeedbackReworkRequestSchema.parse({
        extra_note: "Re-run smoke test after fix",
      }).extra_note,
    ).toBe("Re-run smoke test after fix");
  });
});
