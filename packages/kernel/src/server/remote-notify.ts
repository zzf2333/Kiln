import crypto from "node:crypto";
import type {
  Priority,
  RemoteNotificationChannel,
  RemoteNotificationTestRequest,
} from "@kiln/protocol";
import type { KilnStore } from "../store/index.js";
import { ServerHttpError } from "./errors.js";

const DEFAULT_NOTIFY_TIMEOUT_MS = 4_500;
const MAX_NOTIFY_TIMEOUT_MS = 5_000;

export interface DecisionNotificationInput {
  taskId: string;
  priority: Priority;
  question: string;
}

export interface NotificationDeliveryResult {
  delivered: boolean;
  skipped?: "disabled" | "priority_filtered";
  channel?: RemoteNotificationChannel;
  status?: number;
  error?: string;
}

export interface RemoteNotifierOptions {
  store: KilnStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function toAsciiHeaderValue(value: string): string {
  // HTTP headers in Fetch API must contain only ISO-8859-1 / safe printable ASCII bytes.
  const cleaned = value.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "Kiln Notification";
}

function mapNtfyPriority(priority: Priority): string {
  switch (priority) {
    case "P0":
      return "5";
    case "P1":
      return "4";
    case "P2":
      return "3";
    case "P3":
      return "2";
  }
}

function buildHmacSignature(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * Non-blocking push notification dispatcher for remote mobile access.
 * Supports `bark`, `ntfy`, and generic `webhook` channels with strict <= 5s timeouts
 * and isolated error handling so network failures never disrupt `kilnd`.
 */
export class RemoteNotifier {
  private readonly store: KilnStore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: RemoteNotifierOptions) {
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const requestedTimeout = options.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
    this.timeoutMs = Math.max(100, Math.min(requestedTimeout, MAX_NOTIFY_TIMEOUT_MS));
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Dispatches a push notification when a task requests a human decision and its priority
   * matches `remote.notifications.priorities` (default `["P0", "P1"]`).
   * Never throws; returns a structured outcome for observability and testing.
   */
  async notifyDecisionRequested(
    input: DecisionNotificationInput,
  ): Promise<NotificationDeliveryResult> {
    try {
      const remoteConfig = this.store.readConfig("remote");
      if (
        !remoteConfig ||
        !remoteConfig.notifications.enabled ||
        remoteConfig.notifications.url.trim().length === 0
      ) {
        return { delivered: false, skipped: "disabled" };
      }

      const { channel, url, secret, priorities } = remoteConfig.notifications;
      if (!priorities.includes(input.priority)) {
        return { delivered: false, skipped: "priority_filtered", channel };
      }

      const taskRow = this.store.getTaskIndex(input.taskId);
      const taskTitle = taskRow?.title ?? input.taskId;
      const clickUrl = remoteConfig.public_url
        ? `${remoteConfig.public_url.replace(/\/+$/, "")}/tasks/${encodeURIComponent(input.taskId)}`
        : undefined;

      return await this.sendPayload({
        event: "decision.requested",
        channel,
        url,
        ...(secret !== undefined ? { secret } : {}),
        priority: input.priority,
        taskId: input.taskId,
        title: `[${input.priority}] Kiln 待决 · ${taskTitle}`,
        asciiTitle: `[${input.priority}] Kiln Decision (${input.taskId})`,
        body: input.question,
        ...(clickUrl !== undefined ? { clickUrl } : {}),
      });
    } catch (err) {
      return {
        delivered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Sends a test push notification using saved `remote.notifications` config merged
   * with optional request overrides. Throws `400` if URL is missing/invalid.
   */
  async sendTestNotification(
    override: RemoteNotificationTestRequest = {},
  ): Promise<NotificationDeliveryResult> {
    const remoteConfig = this.store.readConfig("remote");
    const saved = remoteConfig?.notifications;

    const channel: RemoteNotificationChannel =
      override.channel ?? saved?.channel ?? "webhook";
    const url = (override.url ?? saved?.url ?? "").trim();
    const secret = override.secret ?? saved?.secret;

    if (url.length === 0 || !isValidHttpUrl(url)) {
      throw new ServerHttpError(400, {
        error: "invalid_notification_url",
        message: "A valid https:// or http:// notification URL is required",
      });
    }

    const title = override.title ?? "[P1] Kiln 远程通知测试";
    const body =
      override.body ??
      "Kiln remote notification test succeeded. Pending P0/P1 decisions will notify this endpoint.";
    const clickUrl = remoteConfig?.public_url?.replace(/\/+$/, "");

    return await this.sendPayload({
      event: "notification.test",
      channel,
      url,
      ...(secret !== undefined ? { secret } : {}),
      priority: "P1",
      taskId: "test",
      title,
      asciiTitle: "[P1] Kiln Remote Notification Test",
      body,
      ...(clickUrl !== undefined ? { clickUrl } : {}),
    });
  }

  private async sendPayload(params: {
    event: "decision.requested" | "notification.test";
    channel: RemoteNotificationChannel;
    url: string;
    secret?: string;
    priority: Priority;
    taskId: string;
    title: string;
    asciiTitle: string;
    body: string;
    clickUrl?: string;
  }): Promise<NotificationDeliveryResult> {
    if (!isValidHttpUrl(params.url)) {
      return {
        delivered: false,
        channel: params.channel,
        error: "Invalid notification URL",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const { headers, body } = this.buildChannelRequest(params);
      const res = await this.fetchImpl(params.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        return {
          delivered: false,
          channel: params.channel,
          status: res.status,
          error: `Notification endpoint responded with HTTP ${res.status}`,
        };
      }

      return {
        delivered: true,
        channel: params.channel,
        status: res.status,
      };
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === "AbortError"
            ? `Notification timed out after ${this.timeoutMs}ms`
            : err.message
          : String(err);
      return {
        delivered: false,
        channel: params.channel,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private buildChannelRequest(params: {
    event: "decision.requested" | "notification.test";
    channel: RemoteNotificationChannel;
    secret?: string;
    priority: Priority;
    taskId: string;
    title: string;
    asciiTitle: string;
    body: string;
    clickUrl?: string;
  }): { headers: Record<string, string>; body: string } {
    const timestamp = this.now().toISOString();

    if (params.channel === "bark") {
      const payload = JSON.stringify({
        title: params.title,
        body: params.body,
        group: "Kiln",
        level: params.priority === "P0" || params.priority === "P1" ? "timeSensitive" : "active",
        ...(params.clickUrl !== undefined ? { url: params.clickUrl } : {}),
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/json; charset=utf-8",
      };
      if (params.secret !== undefined) {
        headers.Authorization = `Bearer ${params.secret}`;
        headers["X-Kiln-Signature-256"] = buildHmacSignature(params.secret, payload);
      }
      return { headers, body: payload };
    }

    if (params.channel === "ntfy") {
      const textBody = `${params.title}\n${params.body}`;
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
        Title: toAsciiHeaderValue(params.asciiTitle),
        Priority: mapNtfyPriority(params.priority),
        Tags: params.priority === "P0" ? "rotating_light,kiln" : "bell,kiln",
      };
      if (params.clickUrl !== undefined) {
        headers.Click = params.clickUrl;
      }
      if (params.secret !== undefined) {
        headers.Authorization = `Bearer ${params.secret}`;
        headers["X-Kiln-Signature-256"] = buildHmacSignature(params.secret, textBody);
      }
      return { headers, body: textBody };
    }

    const payload = JSON.stringify({
      event: params.event,
      timestamp,
      taskId: params.taskId,
      priority: params.priority,
      title: params.title,
      question: params.body,
      url: params.clickUrl ?? null,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "X-Kiln-Event": params.event,
    };
    if (params.secret !== undefined) {
      headers.Authorization = `Bearer ${params.secret}`;
      headers["X-Kiln-Signature-256"] = buildHmacSignature(params.secret, payload);
    }
    return { headers, body: payload };
  }
}
