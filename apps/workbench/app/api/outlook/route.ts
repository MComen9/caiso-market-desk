import { isOutlookId, OutlookError, queryOutlook } from '@/lib/outlook';
import { localParts } from '@/lib/time';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  try {
    const search = new URL(request.url).searchParams;
    const date = search.get('date') || localParts(new Date()).localDate;
    const id = search.get('feed');
    if (id && !isOutlookId(id)) throw new OutlookError('INVALID_FEED', '数据集不在公开源白名单中。', 400);
    const result = await queryOutlook(date, id && isOutlookId(id) ? [id] : undefined);
    return Response.json(result, {status:result.ok ? 200 : Object.values(result.feeds).every(f => f.status === 'unavailable') ? 200 : 502,headers});
  } catch (e) {
    const error = e instanceof OutlookError ? e : new OutlookError('REQUEST_ERROR','无法完成公开源查询。');
    return Response.json({ok:false,error:{code:error.code,message:error.message}},{status:error.status,headers});
  }
}
