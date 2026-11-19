import type { SessionRef } from "@kiln/protocol";
import { type ExecutionBackend, UnknownBackendError } from "./types.js";

export interface RegisterBackendOptions {
  replace?: boolean;
}

/**
 * Registry mapping backendId to ExecutionBackend instances for session routing and lifecycle management.
 */
export class BackendRegistry {
  private readonly backends = new Map<string, ExecutionBackend>();

  register(backend: ExecutionBackend, options?: RegisterBackendOptions): void {
    if (!backend.backendId) {
      throw new Error("ExecutionBackend.backendId must be a non-empty string");
    }
    if (this.backends.has(backend.backendId) && options?.replace !== true) {
      throw new Error(`Execution backend "${backend.backendId}" is already registered`);
    }
    this.backends.set(backend.backendId, backend);
  }

  get(backendId: string): ExecutionBackend {
    const backend = this.backends.get(backendId);
    if (!backend) {
      throw new UnknownBackendError(backendId);
    }
    return backend;
  }

  has(backendId: string): boolean {
    return this.backends.has(backendId);
  }

  list(): ExecutionBackend[] {
    return Array.from(this.backends.values());
  }

  resolveForSession(sessionRef: SessionRef): ExecutionBackend {
    return this.get(sessionRef.backendId);
  }

  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.backends.values(), async (backend) => {
        if (backend.dispose) {
          await backend.dispose();
        }
      }),
    );
    this.backends.clear();

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to dispose one or more execution backends");
    }
  }
}
