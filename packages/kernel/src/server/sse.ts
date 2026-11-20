import { SseEventSchema, type SseEvent } from "@kiln/protocol";

export type DistributeOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SseEventInput = DistributeOmit<SseEvent, "seq">;

export interface SseHubOptions {
  /** Maximum number of recent events retained for `Last-Event-ID` replay. Defaults to `500`. */
  bufferCapacity?: number;
}

export interface SseStreamOptions {
  lastEventId?: number | null;
  signal?: AbortSignal;
  /** Paired remote device ID owning this SSE connection (absent for local connections). */
  deviceId?: string;
}

export type SseListener = (event: SseEvent, frame: string) => void;

interface ActiveSseStreamEntry {
  close: () => void;
  deviceId?: string;
}

const DEFAULT_BUFFER_CAPACITY = 500;

/**
 * Formats an `SseEvent` into a standard SSE wire frame (`id`, `event`, `data`).
 */
export function formatSseFrame(event: SseEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * In-process monotonic SSE broadcast hub with a bounded ring buffer for `Last-Event-ID` replay.
 */
export class SseHub {
  readonly bufferCapacity: number;

  private nextSeq = 1;
  private readonly buffer: SseEvent[] = [];
  private readonly listeners = new Set<SseListener>();
  private readonly streamClosers = new Set<ActiveSseStreamEntry>();

  constructor(options: SseHubOptions = {}) {
    const capacity = options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`SseHub bufferCapacity must be a positive integer, got: ${capacity}`);
    }
    this.bufferCapacity = capacity;
  }

  /** Latest assigned `seq` (`0` before any event has been published). */
  get currentSeq(): number {
    return this.nextSeq - 1;
  }

  /** Number of active SSE subscribers. */
  get subscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Validates the event against `SseEventSchema` with the next monotonic `seq`,
   * stores it in the bounded ring buffer, and broadcasts it to all active listeners.
   */
  publish(eventWithoutSeq: SseEventInput): SseEvent {
    const candidate = { ...eventWithoutSeq, seq: this.nextSeq };
    const event = SseEventSchema.parse(candidate);
    this.nextSeq += 1;

    if (this.buffer.length >= this.bufferCapacity) {
      this.buffer.shift();
    }
    this.buffer.push(event);

    const frame = formatSseFrame(event);
    for (const listener of Array.from(this.listeners)) {
      listener(event, frame);
    }

    return event;
  }

  /**
   * Returns all buffered events with `seq > lastEventId` in ascending `seq` order.
   */
  replaySince(lastEventId: number): SseEvent[] {
    if (!Number.isInteger(lastEventId) || lastEventId < 0) {
      throw new RangeError(
        `lastEventId must be a non-negative integer, got: ${String(lastEventId)}`,
      );
    }
    return this.buffer.filter((event) => event.seq > lastEventId);
  }

  /**
   * Registers a live SSE listener and returns an idempotent unsubscribe handle.
   */
  subscribe(listener: SseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Creates a UTF-8 `ReadableStream` that replays missed events since `lastEventId` (if provided)
   * and streams live published events until client abort, stream cancellation, or `closeAll()`.
   */
  createEventStream(options: SseStreamOptions = {}): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      this.streamClosers.delete(entry);
      if (options.signal) {
        options.signal.removeEventListener("abort", closeFromHub);
      }
    };

    const closeFromHub = (): void => {
      const controller = streamController;
      cleanup();
      if (controller) {
        try {
          controller.close();
        } catch {
          // Stream may already be closed by consumer disconnect.
        }
      }
    };

    const entry: ActiveSseStreamEntry =
      options.deviceId !== undefined
        ? { close: closeFromHub, deviceId: options.deviceId }
        : { close: closeFromHub };

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
        this.streamClosers.add(entry);

        if (options.signal) {
          if (options.signal.aborted) {
            closeFromHub();
            return;
          }
          options.signal.addEventListener("abort", closeFromHub, { once: true });
        }

        const enqueueFrame = (frame: string): void => {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            cleanup();
          }
        };

        // Replay and subscribe synchronously in the same turn so no event is missed or duplicated.
        if (options.lastEventId !== undefined && options.lastEventId !== null) {
          const missed = this.replaySince(options.lastEventId);
          for (const event of missed) {
            enqueueFrame(formatSseFrame(event));
            if (closed) {
              return;
            }
          }
        }

        unsubscribe = this.subscribe((_event, frame) => {
          enqueueFrame(frame);
        });
      },
      cancel: () => {
        cleanup();
      },
    });
  }

  /**
   * Immediately closes all active remote SSE streams owned by `deviceId`.
   * Returns the number of closed streams.
   */
  closeByDeviceId(deviceId: string): number {
    let closedCount = 0;
    for (const entry of Array.from(this.streamClosers)) {
      if (entry.deviceId === deviceId) {
        entry.close();
        closedCount += 1;
      }
    }
    return closedCount;
  }

  /**
   * Immediately closes all active remote (device-bound) SSE streams while leaving local streams open.
   * Returns the number of closed streams.
   */
  closeAllRemote(): number {
    let closedCount = 0;
    for (const entry of Array.from(this.streamClosers)) {
      if (entry.deviceId !== undefined) {
        entry.close();
        closedCount += 1;
      }
    }
    return closedCount;
  }

  /**
   * Closes all active SSE HTTP response streams cleanly during daemon shutdown.
   */
  closeAll(): void {
    for (const entry of Array.from(this.streamClosers)) {
      entry.close();
    }
    this.listeners.clear();
  }
}
