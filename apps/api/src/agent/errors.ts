/** Errors the HTTP layer maps to status codes (see http/domain-error.filter.ts). */
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

/** The upstream LLM failed or was unreachable -> 502 Bad Gateway. */
export class UpstreamLlmError extends Error {
  /** `message` is client-safe; `detail` (raw upstream body, etc.) is for server logs only. */
  constructor(
    public readonly provider: string,
    message: string,
    public readonly detail?: string,
  ) {
    super(`Upstream LLM error (${provider}): ${message}`);
  }
}

export type GuardrailCode =
  | 'CROSS_CUSTOMER'
  | 'NOT_FOUND'
  | 'INVALID_AMOUNT'
  | 'OVER_REFUND'
  | 'ORDER_CANCELLED'
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS'
  | 'STEP_LIMIT';

/** A policy rule blocked a tool call. The message is safe to show to the model. */
export class GuardrailViolation extends Error {
  constructor(
    public readonly code: GuardrailCode,
    message: string,
  ) {
    super(message);
  }
}
