import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_REPO = "zzf2333/Kiln";

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/qa-sync-issues.mjs --report-dir <dir> [options]",
      "",
      "Options:",
      "  --report-dir <dir>  Path to docs/qa/reports/<runId> (required)",
      "  --apply             Actually create GitHub issues via gh (default: dry-run)",
      "  --include-drafts    Include status: draft files (default: only status: approved)",
      `  --repo <owner/name> Target GitHub repository (default: ${DEFAULT_REPO})`,
      "  -h, --help          Show this help message",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  let reportDir = "";
  let apply = false;
  let includeDrafts = false;
  let repo = DEFAULT_REPO;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--report-dir") {
      reportDir = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--report-dir=")) {
      reportDir = arg.slice("--report-dir=".length);
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--include-drafts") {
      includeDrafts = true;
    } else if (arg === "--repo") {
      repo = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!reportDir) {
    throw new Error("--report-dir is required");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`Invalid --repo "${repo}" (expected owner/name)`);
  }

  return {
    reportDir: path.resolve(reportDir),
    apply,
    includeDrafts,
    repo,
  };
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw, hasFrontmatter: false };
  }

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const val = stripQuotes(trimmed.slice(colonIdx + 1));
    meta[key] = val;
  }

  return { meta, body: match[2].trimStart(), hasFrontmatter: true };
}

function updateFrontmatterField(raw, key, value) {
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?[\s\S]*)$/);
  if (!match) return raw;
  const lines = match[2].split(/\r?\n/);
  const fieldLine = `${key}: "${value.replace(/"/g, '\\"')}"`;
  const existingIdx = lines.findIndex((line) => line.trim().startsWith(`${key}:`));
  if (existingIdx >= 0) {
    lines[existingIdx] = fieldLine;
  } else {
    lines.push(fieldLine);
  }
  return `${match[1]}${lines.join("\n")}${match[3]}`;
}

function buildLabels(meta) {
  const labels = ["qa-codex"];
  if (meta.severity) {
    labels.push(`severity:${meta.severity.toLowerCase()}`);
  }
  if (meta.module) {
    labels.push(`area:${meta.module.toLowerCase()}`);
  }
  return labels;
}

function runGh(args) {
  const res = spawnSync("gh", args, { encoding: "utf8" });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(`gh ${args[0]} failed (${res.status ?? 1}): ${detail}`);
  }
  return (res.stdout || "").trim();
}

function main() {
  const { reportDir, apply, includeDrafts, repo } = parseArgs(process.argv.slice(2));
  const issuesDir = path.join(reportDir, "issues");

  if (!fs.existsSync(issuesDir)) {
    throw new Error(`Issues directory not found: ${issuesDir}`);
  }

  const files = fs
    .readdirSync(issuesDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(issuesDir, name));

  if (files.length === 0) {
    process.stdout.write(`[qa-sync-issues] No issue markdown files in ${issuesDir}\n`);
    return;
  }

  const pending = [];
  const skipped = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter(raw);
    const name = path.basename(filePath);

    if (!parsed.hasFrontmatter) {
      skipped.push({ name, reason: "missing YAML frontmatter" });
      continue;
    }

    const { meta, body } = parsed;
    if (meta.github_issue) {
      skipped.push({ name, reason: `already synced (${meta.github_issue})` });
      continue;
    }

    const status = (meta.status || "draft").toLowerCase();
    const allowed = includeDrafts
      ? status === "approved" || status === "draft"
      : status === "approved";
    if (!allowed) {
      skipped.push({
        name,
        reason: `status="${status}" (use --include-drafts or set status: approved)`,
      });
      continue;
    }

    if (!meta.title) {
      skipped.push({ name, reason: "missing frontmatter title" });
      continue;
    }

    pending.push({
      filePath,
      name,
      raw,
      meta,
      body,
      labels: buildLabels(meta),
    });
  }

  process.stdout.write(
    `[qa-sync-issues] Mode: ${apply ? "APPLY" : "DRY-RUN"} | Repo: ${repo} | Eligible: ${pending.length} | Skipped: ${skipped.length}\n`,
  );

  for (const item of skipped) {
    process.stdout.write(`  [skip] ${item.name}: ${item.reason}\n`);
  }

  if (!apply) {
    for (const item of pending) {
      process.stdout.write(
        `  [would-create] ${item.name}\n    title: ${item.meta.title}\n    labels: ${item.labels.join(", ")}\n    fingerprint: ${item.meta.fingerprint || "(none)"}\n`,
      );
    }
    return;
  }

  if (pending.length === 0) {
    return;
  }

  const openIssuesJson = runGh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    "qa-codex",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,body,url",
  ]);
  const openIssues = JSON.parse(openIssuesJson || "[]");

  for (const item of pending) {
    const fp = item.meta.fingerprint?.trim();
    const duplicate = openIssues.find(
      (issue) =>
        (fp && typeof issue.body === "string" && issue.body.includes(fp)) ||
        issue.title === item.meta.title,
    );
    if (duplicate) {
      process.stdout.write(
        `  [duplicate] ${item.name} matches open issue #${duplicate.number} (${duplicate.url})\n`,
      );
      continue;
    }

    const bodyText = fp ? `${item.body}\n\n<!-- qa-fingerprint: ${fp} -->\n` : `${item.body}\n`;
    const tmpFile = path.join(
      os.tmpdir(),
      `kiln-qa-issue-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );
    fs.writeFileSync(tmpFile, bodyText, "utf8");
    try {
      const ghArgs = [
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        item.meta.title,
        "--body-file",
        tmpFile,
      ];
      for (const label of item.labels) {
        ghArgs.push("--label", label);
      }
      const createdUrl = runGh(ghArgs);
      const updated = updateFrontmatterField(item.raw, "github_issue", createdUrl);
      fs.writeFileSync(item.filePath, updated, "utf8");
      process.stdout.write(`  [created] ${item.name} -> ${createdUrl}\n`);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }
}

main();
