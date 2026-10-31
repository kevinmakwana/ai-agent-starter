import { forwardToApi } from '@/lib/proxy';

// Streams (SSE) and anything carrying a session cookie must never be cached or pre-rendered.
export const dynamic = 'force-dynamic';

async function proxy(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forwardToApi(req, (await params).path);
}

export { proxy as GET, proxy as POST, proxy as PATCH };
