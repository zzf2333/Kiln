import { ZodError } from "zod";
import {
  FullAccessOnlyProviderError,
  IneligibleRoleAgentError,
  UnknownBackendError,
} from "../backend/types.js";
import {
  DependencyCycleError,
  InvalidStateTransitionError,
  MissingDependencyError,
  UnsupportedTrackError,
} from "../state/index.js";
import { InvalidSpacePathError } from "./space-inspect.js";

export type ServerErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 501 | 502;

/**
 * Structured HTTP error carrying status code and JSON error payload for both REST and UDS RPC handlers.
 */
export class ServerHttpError extends Error {
  constructor(
    readonly statusCode: ServerErrorStatus,
    readonly payload: Record<string, unknown>,
  ) {
    super(typeof payload.message === "string" ? payload.message : `HTTP ${statusCode}`);
    this.name = "ServerHttpError";
  }
}

/**
 * Maps domain, validation, state-machine, and storage exceptions to deterministic HTTP status codes and payloads.
 */
export function mapDomainError(err: unknown): {
  statusCode: ServerErrorStatus;
  payload: Record<string, unknown>;
} {
  if (err instanceof ServerHttpError) {
    return { statusCode: err.statusCode, payload: err.payload };
  }
  if (err instanceof InvalidSpacePathError) {
    return {
      statusCode: 400,
      payload: {
        error: err.code,
        message: err.message,
      },
    };
  }
  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      payload: {
        error: "validation_error",
        message: err.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; "),
        issues: err.issues,
      },
    };
  }
  if (err instanceof InvalidStateTransitionError) {
    return {
      statusCode: 409,
      payload: {
        error: "invalid_state_transition",
        from: err.from,
        to: err.to,
        message: err.message,
      },
    };
  }
  if (
    err instanceof DependencyCycleError ||
    err instanceof MissingDependencyError ||
    err instanceof UnsupportedTrackError
  ) {
    return {
      statusCode: 400,
      payload: {
        error: err.name,
        message: err.message,
      },
    };
  }

  if (err instanceof IneligibleRoleAgentError) {
    return {
      statusCode: 409,
      payload: {
        error: "role_agent_ineligible",
        role: err.role,
        agent: err.agent,
        missingCapabilities: err.missingCapabilities,
        message: err.message,
      },
    };
  }
  if (err instanceof FullAccessOnlyProviderError) {
    return {
      statusCode: 409,
      payload: {
        error: "full_access_only_provider",
        agent: err.agent,
        modes: err.modes,
        message: err.message,
      },
    };
  }
  if (err instanceof UnknownBackendError) {
    return {
      statusCode: 409,
      payload: {
        error: "unknown_backend",
        backendId: err.backendId,
        message: err.message,
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  if (/^Invalid\s+/i.test(message)) {
    return { statusCode: 400, payload: { error: "invalid_parameter", message } };
  }
  if (/already exists/i.test(message)) {
    return { statusCode: 409, payload: { error: "conflict", message } };
  }
  if (/terminal task/i.test(message)) {
    return { statusCode: 409, payload: { error: "invalid_state_transition", message } };
  }
  return { statusCode: 500, payload: { error: "internal_error", message } };
}
