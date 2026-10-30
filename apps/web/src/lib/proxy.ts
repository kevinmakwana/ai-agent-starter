// Pass-through to the NestJS API, shared by the catch-all route. It holds no secrets and adds no credentials: the browser
// supplies its own (a conversation token for customers, the session cookie or the reviewer key for the console).
// It must never add X-Requested-By itself: that header is how the API knows the page, not a stray cross-site request, sent it.

// x-forwarded-for lets the API tell clients apart for rate limiting (only honoured when TRUST_PROXY is set there).
const FORWARDED = ['content-type', 'authorization', 'x-conversation-token', 'x-forwarded-for', 'cookie', 'x-requested-by'];

export interface ProxyDeps {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
}

const defaultApiUrl = () => process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;

export async function forwardToApi(req: Request, path: string[], deps: ProxyDeps = {}): Promise<Response> {
  const { fetchImpl = fetch, apiUrl = defaultApiUrl() } = deps;
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const upstream = await fetchImpl(`${apiUrl}/${path.join('/')}${new URL(req.url).search}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
      cache: 'no-store',
      // Aborts the upstream request when the browser goes away, which closes an SSE stream on the API side too.
      signal: req.signal,
    });
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const out = new Headers({ 'content-type': contentType });
    if (contentType.startsWith('text/event-stream')) {
      out.set('cache-control', 'no-cache, no-transform');
      out.set('x-accel-buffering', 'no');
    }
    // A Headers object folds repeated Set-Cookie lines into one; read and append them one by one.
    for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return Response.json({ statusCode: 502, error: 'Bad Gateway', message: 'The API is not reachable' }, { status: 502 });
  }
}
