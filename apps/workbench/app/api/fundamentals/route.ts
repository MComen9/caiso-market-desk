import { fundamentalQuery, queryFundamentals } from '@/lib/fundamentals';
import { OasisError } from '@/lib/oasis';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  try {
    const { date, ids } = fundamentalQuery(new URL(request.url).searchParams);
    const bundle = await queryFundamentals(date, ids);
    // Data absence is a valid report result; individual feed errors stay visible.
    const onlyNoData = Object.values(bundle.feeds).every(feed => feed.status === 'unavailable');
    return Response.json(bundle, { status: bundle.ok || onlyNoData ? 200 : 502, headers });
  } catch (e) {
    const error = e instanceof OasisError ? e : new OasisError('INVALID_REQUEST', '基本面查询参数无效。', 400);
    return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status, headers });
  }
}
