// Provider response bodies are network data: they are `unknown` until narrowed here, so a missing field or a wrong type can only
// become a controlled UpstreamLlmError or a safe default, never a TypeError from reading a property of null.

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A token count from a response: a finite number, else 0 (a string or NaN must not turn into text or NaN in the accounting). */
export const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
