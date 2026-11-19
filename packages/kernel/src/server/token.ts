import crypto from "node:crypto";
import { RunTokenClaimsSchema, type RunTokenClaims } from "@kiln/protocol";

export type RunTokenAuthErrorReason =
  | "malformed"
  | "invalid_header"
  | "invalid_signature"
  | "invalid_claims"
  | "expired";

/**
 * Raised when an MCP `KILN_RUN_TOKEN` fails structural, cryptographic, schema, or expiry checks.
 */
export class RunTokenAuthError extends Error {
  readonly reason: RunTokenAuthErrorReason;

  constructor(reason: RunTokenAuthErrorReason, message: string) {
    super(message);
    this.name = "RunTokenAuthError";
    this.reason = reason;
  }
}

const TOKEN_HEADER = { alg: "HS256", typ: "KILN-RUN" } as const;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_BYTES = 32;

function normalizeSecret(secret: string | Buffer): Buffer {
  const buf = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error("Run token HMAC secret must be a non-empty string or Buffer");
  }
  return buf;
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeBase64UrlJson(segment: string, reason: RunTokenAuthErrorReason): unknown {
  let raw: string;
  try {
    raw = Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    throw new RunTokenAuthError(reason, "Failed to base64url-decode token segment");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RunTokenAuthError(reason, "Token segment is not valid JSON");
  }
}

/**
 * Signs a validated `RunTokenClaims` payload using compact `header.payload.signature` (HMAC-SHA256).
 */
export function signRunToken(claims: RunTokenClaims, secret: string | Buffer): string {
  const key = normalizeSecret(secret);
  const validatedClaims = RunTokenClaimsSchema.parse(claims);
  const encodedHeader = encodeBase64UrlJson(TOKEN_HEADER);
  const encodedPayload = encodeBase64UrlJson(validatedClaims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac("sha256", key).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Verifies compact token format, algorithm header, HMAC-SHA256 (`crypto.timingSafeEqual`),
 * `RunTokenClaimsSchema`, and expiry (`nowSec <= claims.exp`).
 */
export function verifyRunToken(
  token: string,
  secret: string | Buffer,
  nowMs: number = Date.now(),
): RunTokenClaims {
  const key = normalizeSecret(secret);

  if (typeof token !== "string" || token.length === 0) {
    throw new RunTokenAuthError("malformed", "Run token must be a non-empty string");
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RunTokenAuthError("malformed", "Verification timestamp must be a finite non-negative number");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new RunTokenAuthError("malformed", "Run token must contain exactly three segments");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  if (
    !BASE64URL_RE.test(encodedHeader) ||
    !BASE64URL_RE.test(encodedPayload) ||
    !BASE64URL_RE.test(encodedSignature)
  ) {
    throw new RunTokenAuthError("malformed", "Run token contains invalid base64url characters");
  }

  const providedSig = Buffer.from(encodedSignature, "base64url");
  const expectedSig = crypto
    .createHmac("sha256", key)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();

  if (
    providedSig.length !== SHA256_BYTES ||
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(providedSig, expectedSig)
  ) {
    throw new RunTokenAuthError("invalid_signature", "Run token signature verification failed");
  }

  const rawHeader = decodeBase64UrlJson(encodedHeader, "invalid_header");
  if (
    rawHeader === null ||
    typeof rawHeader !== "object" ||
    Array.isArray(rawHeader) ||
    (rawHeader as Record<string, unknown>).alg !== TOKEN_HEADER.alg ||
    (rawHeader as Record<string, unknown>).typ !== TOKEN_HEADER.typ
  ) {
    throw new RunTokenAuthError("invalid_header", "Run token header alg/typ mismatch");
  }

  const rawPayload = decodeBase64UrlJson(encodedPayload, "invalid_claims");
  const parsedClaims = RunTokenClaimsSchema.safeParse(rawPayload);
  if (!parsedClaims.success) {
    throw new RunTokenAuthError(
      "invalid_claims",
      `Run token claims failed schema validation: ${parsedClaims.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec > parsedClaims.data.exp) {
    throw new RunTokenAuthError(
      "expired",
      `Run token expired at ${parsedClaims.data.exp} (now=${nowSec})`,
    );
  }

  return parsedClaims.data;
}
