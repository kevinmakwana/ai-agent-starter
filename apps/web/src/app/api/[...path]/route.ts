// Thin pass-through proxy to the NestJS API. It holds no secrets: the browser supplies its own
// credential (a conversation token for customers, the reviewer key for the console).
const apiUrl = () => process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;
const FORWARDED = ['content-type', 'authorization', 'x-conversation-token'];

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
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return Response.json({ statusCode: 502, error: 'Bad Gateway', message: 'The API is not reachable' }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST };
