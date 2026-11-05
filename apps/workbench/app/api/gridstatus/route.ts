import { availableDatasets, connectionStatus, GridStatusError, gridStatusUsage, queryGridStatus } from '@/lib/gridstatus';

export const dynamic = 'force-dynamic';
const headers = {'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff'};
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    switch(params.get('resource') || 'status') {
      case 'status': return Response.json(connectionStatus(), {headers});
      case 'datasets': return Response.json(await availableDatasets(), {headers});
      case 'data': return Response.json(await queryGridStatus(params), {headers});
      case 'usage': return Response.json(await gridStatusUsage(), {headers});
      default: throw new GridStatusError('INVALID_RESOURCE', '不支持的数据资源。', 400);
    }
  } catch (error) {
    const e = error instanceof GridStatusError ? error : new GridStatusError('QUERY_FAILED', 'GridStatus 查询暂时失败。');
    return Response.json({ok:false, ...connectionStatus(), status:e.code === 'NOT_CONFIGURED' ? 'not_configured' : 'error', error:{code:e.code, message:e.message}}, {status:e.status, headers});
  }
}
