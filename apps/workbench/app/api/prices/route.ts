import { OasisError, queryFromSearchParams, queryMarket } from '@/lib/oasis';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const query = queryFromSearchParams(new URL(request.url).searchParams);
    const result = await queryMarket(query);
    const status = result.ok || result.error?.code === 'NO_DATA' ? 200
      : result.error?.code === 'RATE_LIMITED' ? 429 : result.error?.code === 'UPSTREAM_TIMEOUT' ? 504 : 502;
    return Response.json(result, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    const failure = error instanceof OasisError ? error : new OasisError('INVALID_REQUEST', '查询参数无效。', 400);
    return Response.json({ ok: false, error: { code: failure.code, message: failure.message } },
      { status: failure.status, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
