import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * GET /api/ping
 * Keepalive for Zilliz Free tier — called by Vercel Cron every 5 minutes.
 * Pings Milvus via REST (faster than gRPC for cold-start wakeup).
 */
export async function GET() {
  const address = process.env.MILVUS_ADDRESS;
  const token   = process.env.MILVUS_TOKEN;

  if (!address || !token) {
    return NextResponse.json({ ok: true, milvus: 'not configured' });
  }

  try {
    const base = address.startsWith('http')
      ? address.replace(/\/$/, '')
      : `https://${address.replace(/:443$/, '')}`;
    const url  = `${base}/v2/vectordb/collections/list`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dbName: 'default' }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json() as { code: number; data?: string[] };
    const alive = data.code === 0;

    console.log(`[Ping] Milvus keepalive: code=${data.code} collections=${data.data?.length ?? '?'}`);

    return NextResponse.json({
      ok: true,
      milvus: alive ? 'alive' : 'error',
      collections: data.data ?? [],
      ts: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[Ping] Milvus keepalive failed:', err);
    return NextResponse.json({
      ok: true,
      milvus: 'unreachable',
      error: (err as Error).message,
      ts: new Date().toISOString(),
    });
  }
}
