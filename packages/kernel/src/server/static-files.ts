import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const ASSET_EXTENSION_PATTERN = /\.(?:js|mjs|css|json|svg|png|jpe?g|webp|ico|woff2?|map|txt|webmanifest)$/i;
const HASHED_ASSET_PATTERN = /^assets\/|[-.][a-zA-Z0-9_-]{6,}\.(?:js|mjs|css|svg|png|jpe?g|webp|woff2?|ico)$/;

/**
 * Resolves the default `packages/kernel/public` directory relative to both source (`src/server/`)
 * and bundled (`dist/`) layouts without relying on `process.cwd()`.
 */
export function resolveDefaultPublicDir(): string {
  let current = import.meta.dirname;
  for (let i = 0; i < 4; i++) {
    const pkgPath = path.join(current, "package.json");
    const candidatePublic = path.join(current, "public");
    if (fs.existsSync(pkgPath)) {
      if (fs.existsSync(candidatePublic)) {
        return candidatePublic;
      }
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: unknown };
        if (pkg.name === "@kiln/kernel") {
          return candidatePublic;
        }
      } catch {
        // Ignore invalid package.json during probe
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.resolve(import.meta.dirname, "../../public");
}

function isInsideCanonicalDir(canonicalTarget: string, canonicalDir: string): boolean {
  const prefix = canonicalDir.endsWith(path.sep) ? canonicalDir : canonicalDir + path.sep;
  return canonicalTarget === canonicalDir || canonicalTarget.startsWith(prefix);
}

function extractRawPathname(rawUrl: string, fallbackPath: string): string {
  if (!rawUrl) {
    return fallbackPath;
  }
  const qIdx = rawUrl.indexOf("?");
  const hIdx = rawUrl.indexOf("#");
  const endIdx = qIdx >= 0 && hIdx >= 0 ? Math.min(qIdx, hIdx) : qIdx >= 0 ? qIdx : hIdx;
  const clean = endIdx >= 0 ? rawUrl.slice(0, endIdx) : rawUrl;

  const schemeIdx = clean.indexOf("://");
  if (schemeIdx >= 0) {
    const pathStart = clean.indexOf("/", schemeIdx + 3);
    return pathStart >= 0 ? clean.slice(pathStart) : "/";
  }
  return clean || fallbackPath;
}

type ParseStaticSegmentsResult =
  | { ok: true; segments: string[]; trailingSlash: boolean }
  | { ok: false; status: 400 | 403; reason: string };

function parseAndValidateStaticSegments(rawPathname: string): ParseStaticSegmentsResult {
  if (
    rawPathname.includes("\0") ||
    /%00/i.test(rawPathname) ||
    rawPathname.includes("\\") ||
    /%5c/i.test(rawPathname)
  ) {
    return { ok: false, status: 403, reason: "forbidden_path_characters" };
  }

  const trailingSlash = rawPathname.endsWith("/");
  const rawSegments = rawPathname.split("/");
  const segments: string[] = [];

  for (const rawSeg of rawSegments) {
    if (rawSeg.length === 0) {
      continue;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSeg);
    } catch {
      return { ok: false, status: 400, reason: "malformed_url_encoding" };
    }

    if (
      decoded.includes("\0") ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decoded)
    ) {
      return { ok: false, status: 403, reason: "forbidden_path_characters" };
    }

    if (decoded === "." || decoded === "..") {
      return { ok: false, status: 403, reason: "path_traversal_blocked" };
    }

    segments.push(decoded);
  }

  return { ok: true, segments, trailingSlash };
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function getCacheControl(relPosixPath: string): string {
  const ext = path.extname(relPosixPath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    return "no-cache";
  }
  if (HASHED_ASSET_PATTERN.test(relPosixPath)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=300";
}

function serveVerifiedFile(
  method: string,
  canonicalPublicDir: string,
  candidateFilePath: string,
  relPosixPath: string,
): Response | null {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(candidateFilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = fs.realpathSync(candidateFilePath);
  } catch (err) {
    if (lstat.isSymbolicLink()) {
      return new Response("Forbidden", { status: 403 });
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  if (!isInsideCanonicalDir(canonicalTarget, canonicalPublicDir)) {
    return new Response("Forbidden", { status: 403 });
  }

  const stat = fs.statSync(canonicalTarget);
  if (!stat.isFile()) {
    return null;
  }

  const headers = new Headers({
    "Content-Type": getMimeType(canonicalTarget),
    "Content-Length": String(stat.size),
    "Cache-Control": getCacheControl(relPosixPath),
    "X-Content-Type-Options": "nosniff",
  });

  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const body = fs.readFileSync(canonicalTarget);
  return new Response(body, { status: 200, headers });
}

export interface EmbeddedStaticAsset {
  readonly contentType?: string;
  readBytes(): Uint8Array;
}

export type EmbeddedStaticAssets = ReadonlyMap<string, EmbeddedStaticAsset>;

export interface StaticFilesHandlerOptions {
  publicDir?: string | null;
  embeddedAssets?: EmbeddedStaticAssets | null;
}

function serveEmbeddedAsset(
  method: string,
  relPosixPath: string,
  asset: EmbeddedStaticAsset,
): Response {
  const bytes = asset.readBytes();
  const headers = new Headers({
    "Content-Type": asset.contentType ?? getMimeType(relPosixPath),
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": getCacheControl(relPosixPath),
    "X-Content-Type-Options": "nosniff",
  });

  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(bytes, { status: 200, headers });
}

function serveFromEmbeddedAssets(
  c: Context,
  method: string,
  segments: readonly string[],
  embeddedAssets: EmbeddedStaticAssets,
): Response {
  const relPosix = segments.join("/");

  if (segments.length > 0) {
    const direct = embeddedAssets.get(relPosix);
    if (direct) {
      return serveEmbeddedAsset(method, relPosix, direct);
    }

    const dirRelPosix = `${relPosix}/index.html`;
    const dirIndex = embeddedAssets.get(dirRelPosix);
    if (dirIndex) {
      return serveEmbeddedAsset(method, dirRelPosix, dirIndex);
    }

    if (ASSET_EXTENSION_PATTERN.test(relPosix)) {
      return c.json(
        { error: "not_found", message: `Static asset "${c.req.path}" not found` },
        404,
      );
    }
  }

  const indexAsset = embeddedAssets.get("index.html");
  if (indexAsset) {
    return serveEmbeddedAsset(method, "index.html", indexAsset);
  }

  return c.json({ error: "not_found", message: "Static index.html not found" }, 404);
}

/**
 * Creates a strict single-port static site & SPA fallback handler with traversal,
 * NUL-byte, symlink-escape, and `/api/*` isolation guards.
 * Falls back to `embeddedAssets` when `publicDir` does not exist on disk (e.g. compiled binary).
 */
export function createStaticFilesHandler(
  options: StaticFilesHandlerOptions,
): (c: Context) => Response {
  const publicDir = options.publicDir ?? null;
  const embeddedAssets = options.embeddedAssets ?? null;

  return (c: Context): Response => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
      return c.json(
        { error: "not_found", message: `API endpoint "${c.req.path}" not found` },
        404,
      );
    }

    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return c.json({ error: "not_found", message: "Route not found" }, 404);
    }

    const rawPathname = extractRawPathname(c.req.raw.url, c.req.path);
    const parsed = parseAndValidateStaticSegments(rawPathname);
    if (!parsed.ok) {
      return c.json({ error: parsed.reason, message: "Forbidden path" }, parsed.status);
    }

    if (publicDir === null) {
      if (embeddedAssets && embeddedAssets.size > 0) {
        return serveFromEmbeddedAssets(c, method, parsed.segments, embeddedAssets);
      }
      return c.json(
        { error: "not_found", message: "Web UI assets directory does not exist" },
        404,
      );
    }

    if (!fs.existsSync(publicDir)) {
      if (embeddedAssets && embeddedAssets.size > 0) {
        return serveFromEmbeddedAssets(c, method, parsed.segments, embeddedAssets);
      }
      return c.json(
        { error: "not_found", message: "Web UI assets directory does not exist" },
        404,
      );
    }

    let canonicalPublicDir: string;
    try {
      canonicalPublicDir = fs.realpathSync(publicDir);
      if (!fs.statSync(canonicalPublicDir).isDirectory()) {
        if (embeddedAssets && embeddedAssets.size > 0) {
          return serveFromEmbeddedAssets(c, method, parsed.segments, embeddedAssets);
        }
        return c.json(
          { error: "not_found", message: "Web UI assets path is not a directory" },
          404,
        );
      }
    } catch {
      if (embeddedAssets && embeddedAssets.size > 0) {
        return serveFromEmbeddedAssets(c, method, parsed.segments, embeddedAssets);
      }
      return c.json(
        { error: "not_found", message: "Web UI assets directory unavailable" },
        404,
      );
    }

    const relPosix = parsed.segments.join("/");
    const targetPath =
      parsed.segments.length === 0
        ? path.join(canonicalPublicDir, "index.html")
        : path.join(canonicalPublicDir, ...parsed.segments);

    if (parsed.segments.length > 0) {
      let existingStat: fs.Stats | null = null;
      let isSymlink = false;
      try {
        const lstat = fs.lstatSync(targetPath);
        isSymlink = lstat.isSymbolicLink();
        const canonicalCandidate = fs.realpathSync(targetPath);
        if (!isInsideCanonicalDir(canonicalCandidate, canonicalPublicDir)) {
          return new Response("Forbidden", { status: 403 });
        }
        existingStat = fs.statSync(canonicalCandidate);
      } catch (err) {
        if (isSymlink) {
          return new Response("Forbidden", { status: 403 });
        }
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }

      if (existingStat?.isFile()) {
        const served = serveVerifiedFile(method, canonicalPublicDir, targetPath, relPosix);
        if (served) {
          return served;
        }
      } else if (existingStat?.isDirectory()) {
        const dirIndexPath = path.join(targetPath, "index.html");
        const dirRelPosix = relPosix ? `${relPosix}/index.html` : "index.html";
        const served = serveVerifiedFile(
          method,
          canonicalPublicDir,
          dirIndexPath,
          dirRelPosix,
        );
        if (served) {
          return served;
        }
      }

      if (ASSET_EXTENSION_PATTERN.test(relPosix)) {
        return c.json(
          { error: "not_found", message: `Static asset "${c.req.path}" not found` },
          404,
        );
      }
    }

    const indexPath = path.join(canonicalPublicDir, "index.html");
    const indexResponse = serveVerifiedFile(
      method,
      canonicalPublicDir,
      indexPath,
      "index.html",
    );
    if (indexResponse) {
      return indexResponse;
    }

    return c.json({ error: "not_found", message: "Static index.html not found" }, 404);
  };
}
