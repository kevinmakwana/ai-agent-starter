// Thin pass-through proxy to the NestJS API. It holds no secrets: the browser supplies its own
// credential (a conversation token for customers, the reviewer key for the console).
// Streams (SSE) must never be cached or pre-rendered.
export const dynamic = 'force-dynamic';

const apiUrl = () => process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;
// x-forwarded-for lets the API tell clients apart for rate limiting (only honoured when TRUST_PROXY is set there).
const FORWARDED = ['content-type', 'authorization', 'x-conversation-token', 'x-forwarded-for'];

async function proxy(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const upstream = await fetch(`${apiUrl()}/${path.join('/')}${new URL(req.url).search}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
      cache: 'no-store',
      // Aborts the upstream request when the browser goes away, which closes an SSE stream on the API side too.
      signal: req.signal,
    });
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    const responseHeaders: Record<string, string> = { 'content-type': contentType };
    if (contentType.startsWith('text/event-stream')) {
      responseHeaders['cache-control'] = 'no-cache, no-transform';
      responseHeaders['x-accel-buffering'] = 'no';
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ statusCode: 502, error: 'Bad Gateway', message: 'The API is not reachable' }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST };
