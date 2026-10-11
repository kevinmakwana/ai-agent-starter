// Server-side proxy to the NestJS API. The reviewer key stays on the server and is attached here,
// so it never reaches the browser bundle. (This demo UI doubles as the reviewer console.)
const apiUrl = () => process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;

async function proxy(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const headers = new Headers();
  const type = req.headers.get('content-type');
  if (type) headers.set('content-type', type);
  if (process.env.REVIEWER_API_KEY) headers.set('authorization', `Bearer ${process.env.REVIEWER_API_KEY}`);

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
