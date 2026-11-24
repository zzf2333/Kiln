import fs from "node:fs";
import path from "node:path";
import type {
  AcceptEntryConfig,
  AcceptEvidenceFileCheck,
  AcceptServiceStatus,
  AcceptTrafficSummary,
  AcceptVerificationReport,
  VerifierReceiptFrontmatter,
} from "@kiln/protocol";
import { realpathCanonical } from "../store/fs-atomic.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/**
 * Verifies raw file header magic bytes for PNG, JPEG, or WebP images.
 * Rejects text files or dummy payloads masquerading with an image extension.
 */
export function detectImageMagic(
  buf: Buffer,
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return "image/png";
    }
  }
  if (buf.length >= 3) {
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return "image/jpeg";
    }
  }
  if (buf.length >= 12) {
    // WEBP: "RIFF" .... "WEBP"
    if (
      buf.subarray(0, 4).toString("ascii") === "RIFF" &&
      buf.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
  }
  return null;
}

function readFileHeadBytes(filePath: string, length = 12): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

export function normalizeDeclaredEvidenceRelPath(rawRelPath: string): string | null {
  const trimmed = rawRelPath.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return null;
  const stripped = trimmed.replace(/^(?:\.\/)+/, "");
  const withoutPrefix = stripped.startsWith("evidence/")
    ? stripped.slice("evidence/".length)
    : stripped;
  if (withoutPrefix.length === 0) return null;
  const parts = withoutPrefix.split("/");
  if (parts.some((p) => p.length === 0 || p === "." || p === "..")) {
    return null;
  }
  return withoutPrefix;
}

export interface ValidateVerifierEvidenceGateInput {
  runId: string;
  contractVersion: number;
  runStartedAtIso: string;
  evidenceDir: string;
  acceptEntry: AcceptEntryConfig;
  receipt: VerifierReceiptFrontmatter;
  workspaceMutated: boolean;
  services: readonly AcceptServiceStatus[];
  traffic: AcceptTrafficSummary;
}

/**
 * Evaluates objective, unforgeable anti-fake acceptance checks against a completed `verifier` run:
 * - Source workspace mutation (`verifier_workspace_mutation`)
 * - Target service mid-run crash (`accept_env_service_crashed`)
 * - Missing real HTTP traffic on observed `http_server` runs (`no_real_traffic_observed`)
 * - Physical evidence containment under `evidenceDir`, non-zero size, fresh mtime, and real image magic bytes
 * - Mandatory screenshot presence for browser / desktop_gui runs
 */
export function validateVerifierEvidenceGate(
  input: ValidateVerifierEvidenceGateInput,
): AcceptVerificationReport {
  const {
    runId,
    contractVersion,
    runStartedAtIso,
    evidenceDir,
    acceptEntry,
    receipt,
    workspaceMutated,
    services,
    traffic,
  } = input;

  const rejectionReasons: string[] = [];
  const reasonSet = new Set<string>();
  const addReason = (reason: string): void => {
    if (!reasonSet.has(reason)) {
      reasonSet.add(reason);
      rejectionReasons.push(reason);
    }
  };

  if (workspaceMutated) {
    addReason("verifier_workspace_mutation");
  }

  if (services.some((s) => s.status === "crashed" || s.status === "failed")) {
    addReason("accept_env_service_crashed");
  }

  if (
    receipt.verdict === "pass" &&
    (receipt.failed_scenarios > 0 ||
      receipt.scenarios?.some((s) => s.status === "fail"))
  ) {
    addReason("failed_scenarios_mismatch");
  }

  if (
    acceptEntry.kind === "http_server" &&
    acceptEntry.observe_http !== false &&
    receipt.verdict === "pass" &&
    traffic.total_requests === 0
  ) {
    addReason("no_real_traffic_observed");
  }

  const declaredRawPaths = new Set<string>();
  for (const p of receipt.evidence_files ?? []) {
    declaredRawPaths.add(p);
  }
  for (const sc of receipt.scenarios ?? []) {
    for (const p of sc.evidence_files ?? []) {
      declaredRawPaths.add(p);
    }
  }

  const evidenceDirExists = fs.existsSync(evidenceDir);
  const canonicalEvidenceDir = evidenceDirExists ? realpathCanonical(evidenceDir) : null;
  const evidencePrefix = canonicalEvidenceDir
    ? canonicalEvidenceDir.endsWith(path.sep)
      ? canonicalEvidenceDir
      : canonicalEvidenceDir + path.sep
    : null;

  const parsedStartMs = new Date(runStartedAtIso).getTime();
  const minAllowedMtimeMs = Number.isFinite(parsedStartMs) ? parsedStartMs - 2_000 : 0;

  const evidenceChecks: AcceptEvidenceFileCheck[] = [];
  let validImageCount = 0;

  for (const rawPath of declaredRawPaths) {
    const normRel = normalizeDeclaredEvidenceRelPath(rawPath);
    if (!normRel) {
      addReason("evidence_path_escape");
      evidenceChecks.push({
        rel_path: rawPath,
        kind: "file",
        size_bytes: 0,
        valid: false,
        error: "evidence_path_escape",
      });
      continue;
    }

    const ext = path.extname(normRel).toLowerCase();
    const isImageExt = IMAGE_EXTENSIONS.has(ext);
    const kind: "image" | "file" = isImageExt ? "image" : "file";

    if (!canonicalEvidenceDir || !evidencePrefix) {
      addReason("evidence_file_missing");
      evidenceChecks.push({
        rel_path: normRel,
        kind,
        size_bytes: 0,
        valid: false,
        error: "evidence_file_missing",
      });
      continue;
    }

    const absCandidate = path.resolve(canonicalEvidenceDir, normRel);
    if (!fs.existsSync(absCandidate)) {
      addReason("evidence_file_missing");
      evidenceChecks.push({
        rel_path: normRel,
        kind,
        size_bytes: 0,
        valid: false,
        error: "evidence_file_missing",
      });
      continue;
    }

    let realFile: string;
    let stat: fs.Stats;
    try {
      realFile = realpathCanonical(absCandidate);
      stat = fs.statSync(realFile);
    } catch {
      addReason("evidence_file_missing");
      evidenceChecks.push({
        rel_path: normRel,
        kind,
        size_bytes: 0,
        valid: false,
        error: "evidence_file_missing",
      });
      continue;
    }

    if (!realFile.startsWith(evidencePrefix)) {
      addReason("evidence_path_escape");
      evidenceChecks.push({
        rel_path: normRel,
        kind,
        size_bytes: 0,
        valid: false,
        error: "evidence_path_escape",
      });
      continue;
    }

    if (!stat.isFile() || stat.size <= 0) {
      addReason("evidence_file_empty");
      evidenceChecks.push({
        rel_path: normRel,
        kind,
        size_bytes: stat.size,
        valid: false,
        error: "evidence_file_empty",
      });
      continue;
    }

    if (minAllowedMtimeMs > 0 && stat.mtimeMs < minAllowedMtimeMs) {
      addReason("evidence_timestamp_outside_run");
      evidenceChecks.push({
        rel_path: normRel,
        kind,
        size_bytes: stat.size,
        valid: false,
        error: "evidence_timestamp_outside_run",
      });
      continue;
    }

    if (isImageExt) {
      const magic = detectImageMagic(readFileHeadBytes(realFile, 12));
      if (!magic) {
        addReason("evidence_invalid_image");
        evidenceChecks.push({
          rel_path: normRel,
          kind: "image",
          size_bytes: stat.size,
          valid: false,
          error: "evidence_invalid_image",
        });
        continue;
      }
      validImageCount += 1;
      evidenceChecks.push({
        rel_path: normRel,
        kind: "image",
        size_bytes: stat.size,
        mime_type: magic,
        valid: true,
      });
      continue;
    }

    evidenceChecks.push({
      rel_path: normRel,
      kind: "file",
      size_bytes: stat.size,
      valid: true,
    });
  }

  const requiresVisualEvidence =
    receipt.entry_mode === "browser" ||
    receipt.entry_mode === "desktop_gui" ||
    (acceptEntry.kind === "http_server" && acceptEntry.required_capability === "browser") ||
    acceptEntry.kind === "desktop_app";

  if (receipt.verdict === "pass" && requiresVisualEvidence && validImageCount === 0) {
    addReason("missing_visual_evidence");
  }

  const gateOk = rejectionReasons.length === 0;
  const finalVerdict: AcceptVerificationReport["verdict"] =
    receipt.verdict === "pass" ? (gateOk ? "pass" : "blocked") : "fail";

  return {
    schema_version: 1,
    run_id: runId,
    contract_version: contractVersion,
    checked_at: new Date().toISOString(),
    entry_kind: acceptEntry.kind,
    ...(receipt.entry_mode !== undefined ? { entry_mode: receipt.entry_mode } : {}),
    verdict: finalVerdict,
    gate_ok: gateOk,
    rejection_reasons: rejectionReasons,
    services: [...services],
    traffic,
    evidence_files: evidenceChecks,
    scenarios: receipt.scenarios ?? [],
    ...(receipt.console_errors_count !== undefined
      ? { console_errors_count: receipt.console_errors_count }
      : {}),
  };
}
