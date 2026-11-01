/** Whether a tool result should be shown as blocked: it carries an error, or it is a rejected approval. */
export function isBlockedResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  // Narrowed to a non-null object above; only these two fields are read, and each is checked before use.
  const { error, status } = result as { error?: unknown; status?: unknown };
  return Boolean(error) || status === 'rejected';
}
