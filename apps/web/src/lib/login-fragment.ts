const TOKEN = /^[A-Za-z0-9_-]{20,512}$/;

/** Reads `#token=<value>` from a URL fragment; null when it is absent or not shaped like a token. */
export function readLoginToken(hash: string): string | null {
  const match = /^#token=([^&]*)$/.exec(hash);
  return match && TOKEN.test(match[1]) ? match[1] : null;
}
