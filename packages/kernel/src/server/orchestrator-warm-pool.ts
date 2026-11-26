import fs from "node:fs";
import path from "node:path";
import type { SessionRef } from "@kiln/protocol";
import type { ExecutionBackend } from "../backend/index.js";

function normalizeWarmCwd(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export const DEFAULT_WARM_CACHE_TTL_MS = 300_000;
export const DEFAULT_MAX_IDLE_WARM_SESSIONS = 3;
export const WARM_CONTEXT_PERCENT_LIMIT = 60;
export const WARM_MAX_CONSECUTIVE_REUSES = 3;

export interface WarmSessionEntry {
  taskId: string;
  sessionRef: SessionRef;
  sessionKey: string;
  backend: ExecutionBackend;
  backendId: string;
  agent: string;
  model: string;
  cwd: string;
  rosterRoleId: string | undefined;
  contractVersion: number;
  stepIndex?: number | null;
  stepLabel?: string | undefined;
  customInstructions?: string | undefined;
  lastRunId: string;
  reuseCount: number;
  lastContextPercent: number | null;
  lastUsedAtMs: number;
}

export interface WarmSessionMatchQuery {
  taskId: string;
  backendId: string;
  agent: string;
  model: string;
  cwd: string;
  rosterRoleId: string | undefined;
  contractVersion: number;
  stepIndex?: number | null;
  stepLabel?: string | undefined;
  customInstructions?: string | undefined;
}

interface StoredWarmEntry extends WarmSessionEntry {
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Bounded LRU pool of idle `implement` worker sessions kept alive inside the prompt-cache
 * hot window so retries and review-rework turns can resume via `backend.send()`.
 */
export class WarmSessionPool {
  private readonly entries = new Map<string, StoredWarmEntry>();
  private readonly maxIdleSessions: number;
  private readonly now: () => number;

  constructor(options?: { maxIdleSessions?: number; now?: () => number }) {
    this.maxIdleSessions = options?.maxIdleSessions ?? DEFAULT_MAX_IDLE_WARM_SESSIONS;
    this.now = options?.now ?? (() => Date.now());
  }

  private clearTimer(entry: StoredWarmEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private closeEntryQuietly(entry: StoredWarmEntry): void {
    this.clearTimer(entry);
    void entry.backend.cancel(entry.sessionRef).catch(() => {});
  }

  park(entry: WarmSessionEntry, ttlMs: number = DEFAULT_WARM_CACHE_TTL_MS): void {
    const existing = this.entries.get(entry.taskId);
    if (existing) {
      this.entries.delete(entry.taskId);
      if (existing.sessionRef.sessionId !== entry.sessionRef.sessionId) {
        this.closeEntryQuietly(existing);
      } else {
        this.clearTimer(existing);
      }
    }

    const boundedTtl = Math.max(1_000, ttlMs);
    const stored: StoredWarmEntry = {
      ...entry,
      cwd: normalizeWarmCwd(entry.cwd),
      idleTimer: null,
    };
    const timer = setTimeout(() => {
      const current = this.entries.get(entry.taskId);
      if (current === stored) {
        this.entries.delete(entry.taskId);
        this.closeEntryQuietly(stored);
      }
    }, boundedTtl);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    stored.idleTimer = timer;
    this.entries.set(entry.taskId, stored);

    while (this.entries.size > this.maxIdleSessions) {
      let oldestKey: string | null = null;
      let oldestMs = Infinity;
      for (const [key, item] of this.entries) {
        if (item.lastUsedAtMs < oldestMs) {
          oldestMs = item.lastUsedAtMs;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const evicted = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (evicted) {
        this.closeEntryQuietly(evicted);
      }
    }
  }

  hasWarmSession(
    taskId: string,
    nowMs: number = this.now(),
    ttlMs: number = DEFAULT_WARM_CACHE_TTL_MS,
  ): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) {
      return false;
    }
    if (nowMs - entry.lastUsedAtMs > ttlMs) {
      this.entries.delete(taskId);
      this.closeEntryQuietly(entry);
      return false;
    }
    return true;
  }

  takeMatching(
    query: WarmSessionMatchQuery,
    nowMs: number = this.now(),
    ttlMs: number = DEFAULT_WARM_CACHE_TTL_MS,
  ): WarmSessionEntry | null {
    const entry = this.entries.get(query.taskId);
    if (!entry) {
      return null;
    }
    this.entries.delete(query.taskId);
    this.clearTimer(entry);

    const expired = nowMs - entry.lastUsedAtMs > ttlMs;
    const mismatch =
      entry.backendId !== query.backendId ||
      entry.agent !== query.agent ||
      entry.model !== query.model ||
      entry.cwd !== normalizeWarmCwd(query.cwd) ||
      entry.rosterRoleId !== query.rosterRoleId ||
      entry.contractVersion !== query.contractVersion ||
      (entry.stepIndex ?? null) !== (query.stepIndex ?? null) ||
      (entry.stepLabel ?? "") !== (query.stepLabel ?? "") ||
      (entry.customInstructions ?? "") !== (query.customInstructions ?? "");
    const overWatermark =
      (entry.lastContextPercent !== null &&
        entry.lastContextPercent >= WARM_CONTEXT_PERCENT_LIMIT) ||
      entry.reuseCount >= WARM_MAX_CONSECUTIVE_REUSES;

    if (expired || mismatch || overWatermark) {
      this.closeEntryQuietly(entry);
      return null;
    }

    const { idleTimer: _omitted, ...plain } = entry;
    return plain;
  }

  evictTask(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) {
      return;
    }
    this.entries.delete(taskId);
    this.closeEntryQuietly(entry);
  }

  async evictAll(): Promise<void> {
    const all = Array.from(this.entries.values());
    this.entries.clear();
    await Promise.allSettled(
      all.map(async (entry) => {
        this.clearTimer(entry);
        await entry.backend.cancel(entry.sessionRef).catch(() => {});
      }),
    );
  }
}
