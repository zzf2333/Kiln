import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { z } from "zod";

/**
 * Recursively ensures a directory exists on disk.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeAllSync(fd: number, buf: Buffer, targetDesc: string): void {
  let offset = 0;
  while (offset < buf.length) {
    const written = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (written === 0) {
      throw new Error(`Short write while writing ${targetDesc}`);
    }
    offset += written;
  }
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string"
    ? Buffer.from(content, "utf8")
    : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

export interface WriteFileAtomicOptions {
  /** Optional POSIX file mode (e.g., `0o600` for sensitive config files). */
  mode?: number;
}

/**
 * Writes a file atomically via a same-directory temp file, fsync, and renameSync.
 * Cleans up the temp file on failure before rethrowing.
 */
export function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options?: WriteFileAtomicOptions,
): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const tmpPath = path.join(dir, `.tmp.${process.pid}.${randomUUID()}`);
  const buf = toBuffer(content);
  const mode = options?.mode;

  let fd: number | null = null;
  try {
    fd = mode !== undefined ? fs.openSync(tmpPath, "wx", mode) : fs.openSync(tmpPath, "wx");
    if (mode !== undefined && process.platform !== "win32") {
      fs.fchmodSync(fd, mode);
    }
    writeAllSync(fd, buf, tmpPath);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error while cleaning up failed write; original error is preserved.
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Preserve original write/rename failure; ignore cleanup errors.
    }
    throw err;
  }
}

export type AnyZodType<T> = z.ZodType<T, z.ZodTypeDef, any>;

/**
 * Optionally validates `data` against `schema`, serializes as YAML, and writes atomically.
 */
export function writeYamlAtomic<T>(
  filePath: string,
  data: T,
  schema?: AnyZodType<T>,
  options?: WriteFileAtomicOptions,
): void {
  const validated = schema ? schema.parse(data) : data;
  writeFileAtomic(filePath, stringifyYaml(validated), options);
}

/**
 * Reads a YAML file and validates it against a Zod schema.
 */
export function readYamlValidated<T>(filePath: string, schema: AnyZodType<T>): T {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed: unknown = parseYaml(raw);
  return schema.parse(parsed);
}

/**
 * Reads a YAML file if present; returns `null` only on `ENOENT`.
 */
export function readYamlOptional<T>(filePath: string, schema: AnyZodType<T>): T | null {
  try {
    return readYamlValidated(filePath, schema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Appends a single JSON record as an NDJSON line and fsyncs the descriptor.
 */
export function appendNdjsonLine(filePath: string, record: unknown): void {
  ensureDir(path.dirname(filePath));
  const line = `${JSON.stringify(record)}\n`;
  const buf = Buffer.from(line, "utf8");
  const fd = fs.openSync(filePath, "a");
  try {
    writeAllSync(fd, buf, filePath);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads and validates all non-empty lines of an NDJSON file.
 * Returns `[]` if the file does not exist; includes file path and line number on parse/schema failures.
 */
export function readNdjsonValidated<T>(filePath: string, schema: AnyZodType<T>): T[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const lines = content.split(/\r?\n/);
  const items: T[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    const lineNumber = i + 1;

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON at ${filePath}:${lineNumber}: ${msg}`, { cause: err });
    }

    try {
      items.push(schema.parse(rawJson));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Schema validation failed at ${filePath}:${lineNumber}: ${msg}`, {
        cause: err,
      });
    }
  }

  return items;
}
