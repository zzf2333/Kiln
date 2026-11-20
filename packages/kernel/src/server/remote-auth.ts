import crypto from "node:crypto";
import type { Context } from "hono";
import {
  DEFAULT_REMOTE_PORT,
  DevicesConfigSchema,
  PairedDeviceSchema,
  PublicPairedDeviceSchema,
  createDefaultRemoteConfig,
  type DevicesConfig,
  type PairedDevice,
  type PublicPairedDevice,
  type RemoteConfig,
} from "@kiln/protocol";
import { assertSafeSegment, type KilnStore } from "../store/index.js";
import { ServerHttpError } from "./errors.js";
import type { SseHub } from "./sse.js";

export const KILN_SESSION_COOKIE_NAME = "kiln_session";
export const SESSION_MAX_AGE_SECONDS = 2_592_000; // 30 days
export const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_TOUCH_INTERVAL_MS = 60_000;

/**
 * Reverse-proxy headers strictly rejected on the local (`:4310`) listener so
 * misconfigured tunnels (`tailscale serve`, `cloudflared`, reverse proxies)
 * fail closed and instruct the operator to target the remote port (`:4311`).
 */
export const FORBIDDEN_LOCAL_PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user-profile-pic",
  "x-real-ip",
] as const;

export interface PairingChallengePublic {
  challengeId: string;
  code: string;
  token: string;
  expiresAt: string;
  pairUrl: string | null;
}

interface ActivePairingChallenge {
  id: string;
  token: string;
  code: string;
  createdAtMs: number;
  expiresAtMs: number;
  failedAttempts: number;
}

export interface RemoteAuthManagerOptions {
  store: KilnStore;
  sseHub: SseHub;
  now?: () => number;
  pairingTtlMs?: number;
  maxPairingAttempts?: number;
  touchIntervalMs?: number;
}

export interface CompletePairingInput {
  token?: string;
  code?: string;
  label?: string;
  userAgent?: string;
}

export interface CompletePairingResult {
  sessionToken: string;
  device: PublicPairedDevice;
}

export interface RevokeDeviceResult {
  device: PublicPairedDevice;
  closedStreams: number;
}

export interface RevokeAllDevicesResult {
  revokedCount: number;
  closedStreams: number;
}

function isValidPortString(portStr: string): boolean {
  if (!/^\d{1,5}$/.test(portStr)) {
    return false;
  }
  if (portStr.length > 1 && portStr.startsWith("0")) {
    return false;
  }
  const n = Number(portStr);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Validates that a `Host` header (or URL host) is strictly loopback:
 * `127.0.0.1[:port]`, `localhost[:port]`, or `[::1][:port]`.
 * Blocks DNS rebinding attacks against the unauthenticated local listener.
 */
export function isStrictLoopbackHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase();
  if (host.length === 0) {
    return false;
  }

  const ipv4Match = /^127\.0\.0\.1(?::(\d{1,5}))?$/.exec(host);
  if (ipv4Match) {
    return ipv4Match[1] === undefined || isValidPortString(ipv4Match[1]);
  }

  const localhostMatch = /^localhost(?::(\d{1,5}))?$/.exec(host);
  if (localhostMatch) {
    return localhostMatch[1] === undefined || isValidPortString(localhostMatch[1]);
  }

  const ipv6Match = /^\[::1\](?::(\d{1,5}))?$/.exec(host);
  if (ipv6Match) {
    return ipv6Match[1] === undefined || isValidPortString(ipv6Match[1]);
  }

  return false;
}

/**
 * Validates that an `Origin` header on the local listener belongs to loopback
 * or the local Tauri desktop webview.
 */
export function isLocalAllowedOrigin(rawOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol === "tauri:" && parsed.hostname === "localhost") {
    return true;
  }
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.hostname === "tauri.localhost"
  ) {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return isStrictLoopbackHost(parsed.host);
}

/**
 * Computes the lowercase 64-character SHA-256 hex digest of a session token.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time string comparison via SHA-256 digest normalization + `crypto.timingSafeEqual`,
 * preventing both byte-value and string-length timing side channels.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Constant-time comparison for 64-character hex SHA-256 digests.
 */
export function timingSafeHexEqual(hexA: string, hexB: string): boolean {
  if (hexA.length !== 64 || hexB.length !== 64) {
    return false;
  }
  const bufA = Buffer.from(hexA, "hex");
  const bufB = Buffer.from(hexB, "hex");
  if (bufA.length !== 32 || bufB.length !== 32) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Extracts `kiln_session` cookie value from a raw HTTP `Cookie` header without substring matching.
 */
export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }
  const pairs = cookieHeader.split(";");
  for (const rawPair of pairs) {
    const trimmed = rawPair.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eqIdx).trim();
    if (name !== KILN_SESSION_COOKIE_NAME) {
      continue;
    }
    let value = trimmed.slice(eqIdx + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (value.length === 0 || /[\s\u0000-\u001f\u007f]/.test(value)) {
      return null;
    }
    return value;
  }
  return null;
}

function parseForwardedParam(
  forwardedHeader: string | undefined,
  key: "proto" | "host",
): string | null {
  if (!forwardedHeader) {
    return null;
  }
  const firstEntry = forwardedHeader.split(",")[0];
  if (!firstEntry) {
    return null;
  }
  for (const segment of firstEntry.split(";")) {
    const trimmed = segment.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const k = trimmed.slice(0, eqIdx).trim().toLowerCase();
    if (k !== key) {
      continue;
    }
    let val = trimmed.slice(eqIdx + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    return val.length > 0 ? val : null;
  }
  return null;
}

/**
 * Detects whether the client reached Kiln over HTTPS directly or via reverse proxy
 * (`X-Forwarded-Proto: https`, `Forwarded: proto=https`, or `https:` URL).
 */
export function isSecureRequest(c: Context): boolean {
  const xfp = c.req.header("x-forwarded-proto");
  if (xfp) {
    const firstProto = xfp.split(",")[0]?.trim().toLowerCase();
    if (firstProto === "https") {
      return true;
    }
    if (firstProto === "http") {
      return false;
    }
  }
  const fwdProto = parseForwardedParam(c.req.header("forwarded"), "proto")?.toLowerCase();
  if (fwdProto === "https") {
    return true;
  }
  if (fwdProto === "http") {
    return false;
  }
  return c.req.url.toLowerCase().startsWith("https://");
}

export function formatSessionCookieHeader(
  sessionToken: string,
  options: { secure: boolean; maxAgeSeconds?: number },
): string {
  const maxAge = options.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;
  const parts = [
    `${KILN_SESSION_COOKIE_NAME}=${sessionToken}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function formatClearSessionCookieHeader(options: { secure: boolean }): string {
  const parts = [
    `${KILN_SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function normalizeOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.origin === "null") {
      return null;
    }
    // Reject Origins that carry path/query/hash/userinfo beyond exact origin.
    if (parsed.origin !== raw.trim()) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildExpectedOrigin(proto: string, host: string): string | null {
  const cleanProto = proto.toLowerCase();
  if (cleanProto !== "http" && cleanProto !== "https") {
    return null;
  }
  const cleanHost = host.trim();
  if (cleanHost.length === 0 || /[\s/@\\]/.test(cleanHost)) {
    return null;
  }
  try {
    const parsed = new URL(`${cleanProto}://${cleanHost}`);
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Verifies CSRF protection on remote (`:4311`) mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`):
 * - If `Origin` header is present: MUST match the request's effective origin (supporting
 *   reverse-proxy `X-Forwarded-Proto` / `X-Forwarded-Host` / `Forwarded` and configured `public_url`).
 *   Mismatched `Origin` is ALWAYS rejected even if `X-Kiln-Client: web` is also sent.
 * - If `Origin` header is absent: requires explicit `X-Kiln-Client: web` header.
 */
export function verifyRemoteCsrf(
  c: Context,
  remoteConfig: RemoteConfig | null,
): { ok: true } | { ok: false; error: "csrf_origin_mismatch" | "csrf_check_failed"; message: string } {
  const originHeader = c.req.header("origin");
  if (originHeader !== undefined) {
    const normalizedOrigin = normalizeOrigin(originHeader);
    if (!normalizedOrigin) {
      return {
        ok: false,
        error: "csrf_origin_mismatch",
        message: `Invalid Origin header "${originHeader}"`,
      };
    }

    const effectiveProto = isSecureRequest(c) ? "https" : "http";
    const allowedOrigins = new Set<string>();

    const hostHeader = c.req.header("host");
    if (hostHeader) {
      const originFromHost = buildExpectedOrigin(effectiveProto, hostHeader);
      if (originFromHost) {
        allowedOrigins.add(originFromHost);
      }
    } else {
      try {
        const urlHost = new URL(c.req.url).host;
        const originFromUrl = buildExpectedOrigin(effectiveProto, urlHost);
        if (originFromUrl) {
          allowedOrigins.add(originFromUrl);
        }
      } catch {
        // Ignore malformed request URL; allowedOrigins stays empty -> fail closed.
      }
    }

    const xForwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
    if (xForwardedHost) {
      const originFromXfh = buildExpectedOrigin(effectiveProto, xForwardedHost);
      if (originFromXfh) {
        allowedOrigins.add(originFromXfh);
      }
    }

    const fwdHost = parseForwardedParam(c.req.header("forwarded"), "host");
    if (fwdHost) {
      const originFromFwd = buildExpectedOrigin(effectiveProto, fwdHost);
      if (originFromFwd) {
        allowedOrigins.add(originFromFwd);
      }
    }

    if (remoteConfig?.public_url) {
      try {
        const publicOrigin = new URL(remoteConfig.public_url).origin;
        if (publicOrigin !== "null") {
          allowedOrigins.add(publicOrigin);
        }
      } catch {
        // Ignore invalid configured public_url.
      }
    }

    if (!allowedOrigins.has(normalizedOrigin)) {
      return {
        ok: false,
        error: "csrf_origin_mismatch",
        message: `Origin "${originHeader}" does not match expected remote origin`,
      };
    }
    return { ok: true };
  }

  const clientHeader = c.req.header("x-kiln-client")?.trim().toLowerCase();
  if (clientHeader === "web") {
    return { ok: true };
  }

  return {
    ok: false,
    error: "csrf_check_failed",
    message:
      "Mutating requests on the remote port require a same-origin Origin header or X-Kiln-Client: web",
  };
}

function toPublicDevice(device: PairedDevice): PublicPairedDevice {
  const { token_sha256: _omitted, ...publicFields } = device;
  return PublicPairedDeviceSchema.parse(publicFields);
}

function inferDeviceLabel(userAgent: string | undefined): string {
  if (!userAgent || userAgent.trim().length === 0) {
    return "Paired Device";
  }
  const ua = userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android Device";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac Browser";
  if (/Windows/i.test(ua)) return "Windows Browser";
  if (/Linux/i.test(ua)) return "Linux Browser";
  return "Paired Device";
}

function normalizePairingCode(raw: string): string {
  return raw.replace(/[\s-]+/g, "").trim();
}

export function buildPairUrl(publicUrl: string | undefined, token: string): string | null {
  if (!publicUrl) {
    return null;
  }
  const trimmed = publicUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return null;
  }
  return `${trimmed}/#pair=${encodeURIComponent(token)}`;
}

/**
 * Manages single-use in-memory pairing challenges, SHA-256-hashed paired device
 * persistence (`~/.kiln/config/devices.yaml`, mode `0600`), constant-time session
 * authentication, and immediate SSE stream revocation.
 */
export class RemoteAuthManager {
  private readonly store: KilnStore;
  private readonly sseHub: SseHub;
  private readonly now: () => number;
  private readonly pairingTtlMs: number;
  private readonly maxPairingAttempts: number;
  private readonly touchIntervalMs: number;

  private activeChallenge: ActivePairingChallenge | null = null;

  constructor(options: RemoteAuthManagerOptions) {
    this.store = options.store;
    this.sseHub = options.sseHub;
    this.now = options.now ?? (() => Date.now());
    this.pairingTtlMs = options.pairingTtlMs ?? PAIRING_TTL_MS;
    this.maxPairingAttempts = options.maxPairingAttempts ?? PAIRING_MAX_FAILED_ATTEMPTS;
    this.touchIntervalMs = options.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
  }

  readRemoteConfig(): RemoteConfig {
    return this.store.readConfig("remote") ?? createDefaultRemoteConfig();
  }

  getEffectiveRemotePort(): number {
    return this.store.readConfig("remote")?.remote_port ?? DEFAULT_REMOTE_PORT;
  }

  private readDevicesConfig(): DevicesConfig {
    return (
      this.store.readConfig("devices") ?? {
        schema_version: 1,
        devices: [],
      }
    );
  }

  private writeDevicesConfig(config: DevicesConfig): void {
    const validated = DevicesConfigSchema.parse(config);
    this.store.writeConfig("devices", validated);
  }

  /**
   * Creates a new single-use pairing challenge (replacing any previously active challenge).
   */
  createPairingChallenge(): PairingChallengePublic {
    const nowMs = this.now();
    const expiresAtMs = nowMs + this.pairingTtlMs;
    const challenge: ActivePairingChallenge = {
      id: `pair-${crypto.randomUUID().slice(0, 12)}`,
      token: crypto.randomBytes(32).toString("base64url"),
      code: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"),
      createdAtMs: nowMs,
      expiresAtMs,
      failedAttempts: 0,
    };
    this.activeChallenge = challenge;

    const remoteConfig = this.store.readConfig("remote");
    return {
      challengeId: challenge.id,
      code: challenge.code,
      token: challenge.token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      pairUrl: buildPairUrl(remoteConfig?.public_url, challenge.token),
    };
  }

  /**
   * Validates and atomically consumes the active pairing challenge, minting a 256-bit
   * random session token and persisting ONLY its SHA-256 hash to `devices.yaml` (`0600`).
   */
  completePairing(input: CompletePairingInput): CompletePairingResult {
    const challenge = this.activeChallenge;
    if (!challenge) {
      throw new ServerHttpError(401, {
        error: "invalid_pairing_challenge",
        message: "No active pairing challenge; generate a new pairing code on the desktop host",
      });
    }

    const nowMs = this.now();
    if (nowMs > challenge.expiresAtMs) {
      this.activeChallenge = null;
      throw new ServerHttpError(401, {
        error: "pairing_expired",
        message: "Pairing challenge has expired; generate a new pairing code",
      });
    }

    if (challenge.failedAttempts >= this.maxPairingAttempts) {
      this.activeChallenge = null;
      throw new ServerHttpError(429, {
        error: "pairing_attempts_exceeded",
        attemptsRemaining: 0,
        message: "Maximum failed pairing attempts exceeded; challenge invalidated",
      });
    }

    const hasToken = typeof input.token === "string" && input.token.trim().length > 0;
    const hasCode = typeof input.code === "string" && input.code.trim().length > 0;
    if (!hasToken && !hasCode) {
      throw new ServerHttpError(400, {
        error: "missing_pairing_credentials",
        message: "Either pairing token or 6-digit code is required",
      });
    }

    const tokenMatched = hasToken
      ? timingSafeStringEqual(input.token!.trim(), challenge.token)
      : true;
    const codeMatched = hasCode
      ? timingSafeStringEqual(normalizePairingCode(input.code!), challenge.code)
      : true;

    if (!tokenMatched || !codeMatched) {
      challenge.failedAttempts += 1;
      const attemptsRemaining = Math.max(0, this.maxPairingAttempts - challenge.failedAttempts);
      if (challenge.failedAttempts >= this.maxPairingAttempts) {
        this.activeChallenge = null;
        throw new ServerHttpError(429, {
          error: "pairing_attempts_exceeded",
          attemptsRemaining: 0,
          message: "Maximum failed pairing attempts exceeded; pairing challenge has been invalidated",
        });
      }
      throw new ServerHttpError(401, {
        error: "invalid_pairing_credentials",
        attemptsRemaining,
        message: "Invalid pairing token or code",
      });
    }

    // Consume challenge synchronously & atomically before minting/writing session.
    this.activeChallenge = null;

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const tokenSha256 = hashSessionToken(sessionToken);
    const nowIso = new Date(nowMs).toISOString();
    const userAgent =
      typeof input.userAgent === "string" && input.userAgent.trim().length > 0
        ? input.userAgent.trim().slice(0, 256)
        : undefined;
    const label =
      typeof input.label === "string" && input.label.trim().length > 0
        ? input.label.trim().slice(0, 120)
        : inferDeviceLabel(userAgent);

    const newDevice = PairedDeviceSchema.parse({
      id: `dev-${crypto.randomUUID().slice(0, 12)}`,
      label,
      token_sha256: tokenSha256,
      created_at: nowIso,
      last_seen_at: nowIso,
      ...(userAgent !== undefined ? { last_user_agent: userAgent } : {}),
    });

    const existing = this.readDevicesConfig();
    this.writeDevicesConfig({
      schema_version: 1,
      devices: [...existing.devices, newDevice],
    });

    return {
      sessionToken,
      device: toPublicDevice(newDevice),
    };
  }

  /**
   * Authenticates a raw `Cookie` header against non-revoked paired devices using
   * constant-time SHA-256 digest comparison. Returns `null` if missing, invalid, or revoked.
   */
  authenticateCookie(
    cookieHeader: string | undefined,
    userAgent?: string,
  ): PublicPairedDevice | null {
    const token = parseSessionCookie(cookieHeader);
    if (!token) {
      return null;
    }

    const candidateHash = hashSessionToken(token);
    const config = this.readDevicesConfig();
    let matchedIndex = -1;

    // Scan all devices without early break to avoid leaking index timing.
    for (let i = 0; i < config.devices.length; i++) {
      const dev = config.devices[i]!;
      const eq = timingSafeHexEqual(candidateHash, dev.token_sha256);
      if (eq && dev.revoked_at === undefined) {
        matchedIndex = i;
      }
    }

    if (matchedIndex < 0) {
      return null;
    }

    const matched = config.devices[matchedIndex]!;
    const nowMs = this.now();
    const cleanUa =
      typeof userAgent === "string" && userAgent.trim().length > 0
        ? userAgent.trim().slice(0, 256)
        : undefined;
    const lastSeenMs = Date.parse(matched.last_seen_at);
    const uaChanged = cleanUa !== undefined && cleanUa !== matched.last_user_agent;
    const staleLastSeen =
      !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= this.touchIntervalMs;

    if (uaChanged || staleLastSeen) {
      const updatedDevice: PairedDevice = {
        ...matched,
        last_seen_at: new Date(nowMs).toISOString(),
        ...(cleanUa !== undefined ? { last_user_agent: cleanUa } : {}),
      };
      const nextDevices = [...config.devices];
      nextDevices[matchedIndex] = updatedDevice;
      this.writeDevicesConfig({
        schema_version: 1,
        devices: nextDevices,
      });
      return toPublicDevice(updatedDevice);
    }

    return toPublicDevice(matched);
  }

  listDevices(): PublicPairedDevice[] {
    return this.readDevicesConfig().devices.map(toPublicDevice);
  }

  activeDeviceCount(): number {
    return this.readDevicesConfig().devices.filter((d) => d.revoked_at === undefined).length;
  }

  /**
   * Revokes a paired device by ID in `devices.yaml` and immediately disconnects
   * all active remote SSE streams owned by that device.
   */
  revokeDevice(rawDeviceId: string): RevokeDeviceResult {
    const deviceId = assertSafeSegment(rawDeviceId, "deviceId");
    const config = this.readDevicesConfig();
    const idx = config.devices.findIndex((d) => d.id === deviceId);
    if (idx < 0) {
      throw new ServerHttpError(404, {
        error: "device_not_found",
        deviceId,
        message: `Paired device "${deviceId}" does not exist`,
      });
    }

    const current = config.devices[idx]!;
    const nowIso = new Date(this.now()).toISOString();
    const updated: PairedDevice =
      current.revoked_at !== undefined
        ? current
        : {
            ...current,
            revoked_at: nowIso,
          };

    const nextDevices = [...config.devices];
    nextDevices[idx] = updated;
    this.writeDevicesConfig({
      schema_version: 1,
      devices: nextDevices,
    });

    const closedStreams = this.sseHub.closeByDeviceId(deviceId);
    return {
      device: toPublicDevice(updated),
      closedStreams,
    };
  }

  /**
   * Revokes all active paired devices in `devices.yaml` and immediately disconnects
   * all active remote SSE streams.
   */
  revokeAllDevices(): RevokeAllDevicesResult {
    const config = this.readDevicesConfig();
    const nowIso = new Date(this.now()).toISOString();
    let revokedCount = 0;

    const nextDevices = config.devices.map((dev) => {
      if (dev.revoked_at !== undefined) {
        return dev;
      }
      revokedCount += 1;
      return {
        ...dev,
        revoked_at: nowIso,
      };
    });

    if (revokedCount > 0) {
      this.writeDevicesConfig({
        schema_version: 1,
        devices: nextDevices,
      });
    }

    const closedStreams = this.sseHub.closeAllRemote();
    return {
      revokedCount,
      closedStreams,
    };
  }
}
