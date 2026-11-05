import bootstrap from '@/data/strategy-bootstrap.json';
import researchHistory from '@/data/strategy-history.json';
import currentHistory from '@/data/strategy-history-current.json';
import { buildHourlyRows } from '@/lib/analytics';
import { addDays, localParts } from '@/lib/time';
import { queryMarket, validateQuery, OasisError } from '@/lib/oasis';
import { runStrategy, validateStrategyRequest } from '@/lib/strategy-engine';
import { parseForecastImport } from '@/lib/strategy-forecast';
import { listResearchRecords, readResearchRecord, ResearchError, saveResearchRecord, sha256 } from '@/lib/strategy-storage';
import type { ActualHour, EngineInput, ForecastBatch, PriceArchive, RecordSummary, StrategyCatalog, StrategyRun } from '@/lib/strategy-types';

export const dynamic = 'force-dynamic';
const BUILTIN = bootstrap as PriceArchive;
const HISTORY = researchHistory as PriceArchive;
const CURRENT: PriceArchive = {
  ...currentHistory,
  rows: currentHistory.rows.map(row => Object.fromEntries(currentHistory.fields.map((field, index) => [field, row[index]])) as unknown as ActualHour),
};
const BUILTINS = [CURRENT, HISTORY, BUILTIN];
const headers = {'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'};
const respond = (body: unknown, status = 200) => Response.json(body, {status, headers});
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const fail = (error: unknown) => {
  if (error instanceof ResearchError || error instanceof OasisError)
    return respond({ok:false,error:{code:error.code,message:error.message}},error.status);
  if (error instanceof Error && /D1|SQLITE|database|binding/i.test(error.message)) {
    console.error('Research database failure', error.message.slice(0,250));
    return respond({ok:false,error:{code:'STORAGE_ERROR',message:'记录存储暂时无法完成，本次操作没有保存成功。请稍后重试。'}},503);
  }
  return respond({ok:false,error:{code:'INVALID_INPUT',message:error instanceof Error ? error.message : '数据格式无效，请检查输入后重试。'}},400);
};
function priceSummary(archive: PriceArchive): RecordSummary {
  return {id:archive.id,kind:'price',name:archive.name,createdAt:archive.createdAt,digest:archive.digest,startDate:archive.startDate,endDate:archive.endDate,count:archive.rows.length,nodes:archive.nodes,source:'CAISO OASIS'};
}
async function priceArchive(id: string): Promise<PriceArchive> {
  return BUILTINS.find(archive=>archive.id===id) || readResearchRecord<PriceArchive>(id,'price');
}
function metadata(value: unknown, fallback: string, maximum = 120) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value))
    throw new ResearchError('INVALID_METADATA', `名称、来源或版本字段无效（上限 ${maximum} 个字符）。`);
  return value.trim();
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resource = params.get('resource') || 'catalog';
    if (resource === 'catalog') {
      try {
        const records = await listResearchRecords();
        const result: StrategyCatalog = {ok:true,persistent:true,prices:[...BUILTINS.map(priceSummary),...records.filter(r=>r.kind==='price')],forecasts:records.filter(r=>r.kind==='forecast'),runs:records.filter(r=>r.kind==='run')};
        return respond(result);
      } catch (error) {
        console.error('Research catalog unavailable', error instanceof Error ? error.message.slice(0,180) : 'unknown');
        return respond({ok:true,persistent:false,message:'研究记录存储暂时不可用；预载价格仍可查看。请稍后刷新，未保存的内容不会被标为已留档。',prices:BUILTINS.map(priceSummary),forecasts:[],runs:[]} satisfies StrategyCatalog);
      }
    }
    const id = params.get('id') || '';
    if (resource === 'price') return respond({ok:true,archive:await priceArchive(id)});
    if (resource === 'forecast') return respond({ok:true,batch:await readResearchRecord<ForecastBatch>(id,'forecast')});
    if (resource === 'run') return respond({ok:true,run:await readResearchRecord<StrategyRun>(id,'run')});
    throw new ResearchError('INVALID_RESOURCE','请选择价格、预测或运行记录。');
  } catch (error) { return fail(error); }
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  // This workbench is loopback-only; the public viewer has no writable APIs.
  // Same-origin writes add a browser check, not user authentication. Shared
  // remote deployment requires real authentication and authorization first.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new ResearchError('ORIGIN_MISMATCH','请求来源与当前站点不一致。',403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new ResearchError('INVALID_CONTENT_TYPE','请使用 JSON 请求。',415);
  if (Number(request.headers.get('content-length') || 0) > 6_000_000) throw new ResearchError('BODY_TOO_LARGE','文件超过 5 MB，请拆分导入。',413);
  const reader = request.body?.getReader();
  if (!reader) throw new ResearchError('EMPTY_BODY','请求内容为空。');
  const decoder = new TextDecoder(); let text = '', size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > 6_000_000) { await reader.cancel(); throw new ResearchError('BODY_TOO_LARGE','文件超过 5 MB，请拆分导入。',413); }
    text += decoder.decode(part.value,{stream:true});
  }
  text += decoder.decode();
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResearchError('INVALID_BODY','请求格式应为 JSON 对象。');
  return value as Record<string, unknown>;
}

function combinePrices(archives: PriceArchive[]): {rows: ActualHour[]; overlaps: number} {
  const map = new Map<string, ActualHour>(); let overlaps = 0;
  // Newer observations take priority only inside this explicit, saved set of versions.
  const ordered = [...archives].sort((a,b)=>b.fetchedAt.localeCompare(a.fetchedAt) || b.id.localeCompare(a.id));
  for (const archive of ordered) for (const row of archive.rows) {
    const key = `${row.node}|${row.startUtc}`;
    if (!map.has(key)) map.set(key,row); else overlaps++;
  }
  return {rows:[...map.values()].sort((a,b)=>a.startUtc.localeCompare(b.startUtc)||a.node.localeCompare(b.node)),overlaps};
}

export async function POST(request: Request) {
  try {
    const body = await requestBody(request);
    if (body.action === 'import_forecast') {
      if (typeof body.text !== 'string' || new TextEncoder().encode(body.text).byteLength > 5_000_000)
        throw new ResearchError('INVALID_IMPORT','请选择不超过 5 MB 的 CSV 或 JSON 预测文件。');
      const createdAt = new Date().toISOString();
      const name = metadata(body.name,'外部电价预测');
      const source = metadata(body.source,'用户提供的外部预测',300);
      const modelVersion = metadata(body.modelVersion,'import-v1',80);
      const parsed = parseForecastImport(body.text,{name,source,modelVersion},createdAt);
      const digest = await sha256(JSON.stringify({source,modelVersion,points:parsed.points}));
      const batch: ForecastBatch = {id:`forecast_${crypto.randomUUID()}`,name,createdAt,source,modelVersion,digest,points:parsed.points,warnings:[...parsed.warnings,'issuedAt 为导入文件声明的发布时间；平台留档时间为 createdAt，两者不互相替代。']};
      const days = batch.points.map(row=>localParts(row.startUtc).localDate).sort();
      await saveResearchRecord({id:batch.id,kind:'forecast',name,createdAt,digest,count:batch.points.length,nodes:[...new Set(batch.points.map(r=>r.node))],source,startDate:days[0],endDate:days.at(-1)},batch);
      return respond({ok:true,batch});
    }
    if (body.action === 'fetch_prices') {
      if (typeof body.startDate !== 'string' || typeof body.endDate !== 'string' || !Array.isArray(body.nodes) || !body.nodes.every(n=>typeof n==='string'))
        throw new ResearchError('INVALID_PRICE_QUERY','请选择起止日期和 1 至 6 个节点。');
      const query = validateQuery({market:'DAM',startDate:body.startDate,endDate:body.endDate,nodes:body.nodes as string[]});
      const dam = await queryMarket(query);
      if (!dam.ok && dam.error?.code !== 'NO_DATA') throw new ResearchError(dam.error?.code || 'OASIS_ERROR',dam.error?.message || '日前价格读取失败。',502);
      const fmm = await queryMarket({...query,market:'FMM'});
      if (!fmm.ok && fmm.error?.code !== 'NO_DATA') throw new ResearchError(fmm.error?.code || 'OASIS_ERROR',fmm.error?.message || 'FMM 价格读取失败。',502);
      if (!dam.intervals.length && !fmm.intervals.length) throw new ResearchError('NO_DATA','此日期与节点没有返回 DA 或 FMM 价格，请检查日期和节点代码。',404);
      const rows: ActualHour[] = query.nodes.flatMap(node=>buildHourlyRows({DAM:dam,FMM:fmm},node,query.startDate,query.endDate)).map(({node,startUtc,endUtc,localDate,localHour,utcOffset,dam,fmm,fmmCount,paired})=>({node,startUtc,endUtc,localDate,localHour,utcOffset,dam,fmm,fmmCount,paired}));
      const createdAt = new Date().toISOString(), fetchedAt = [dam.fetchedAt,fmm.fetchedAt].sort().at(-1)!;
      const digest = await sha256(JSON.stringify(rows));
      const archive: PriceArchive = {id:`price_${crypto.randomUUID()}`,name:`OASIS 价格 · ${query.startDate} 至 ${query.endDate}`,createdAt,startDate:query.startDate,endDate:query.endDate,nodes:query.nodes,rows,sourceUrls:[dam.sourceUrl,fmm.sourceUrl],fetchedAt,digest,warnings:[...new Set([...dam.warnings,...fmm.warnings,'这是本次获取的价格版本，不能据此证明历史首次发布值。'])]};
      if (rows.some(r=>!r.paired)) archive.warnings.push(`${rows.filter(r=>!r.paired).length} 个节点小时尚无完整 DA / 四段 FMM 组合；保留缺失。`);
      await saveResearchRecord(priceSummary(archive),archive);
      return respond({ok:true,archive});
    }
    if (body.action === 'run') {
      const selected = validateStrategyRequest(body.request);
      if (!Array.isArray(selected.priceArchiveIds) || selected.priceArchiveIds.length < 1 || selected.priceArchiveIds.length > 24)
        throw new ResearchError('INVALID_ARCHIVES','请选择 1 至 24 份价格版本，包含回测前的训练日期。');
      const archives: PriceArchive[] = [];
      for (const id of [...new Set(selected.priceArchiveIds)]) archives.push(await priceArchive(id));
      const combined = combinePrices(archives);
      // Retain every value the strategy can consume, including nested baseline
      // history when ranking nodes. The full archive remains separately readable.
      // This keeps a one-day simulation on a yearly archive within the record budget.
      const rankedBaseline = selected.forecastMode === 'baseline' && selected.configs.some(config => config.selection === 'ranked');
      const lookback = selected.baseline.lagDays + selected.baseline.lookbackDays - 1;
      const inputStartDate = addDays(selected.startDate, -lookback * (rankedBaseline ? 2 : 1));
      const selectedNodes = new Set(selected.configs.flatMap(config => config.nodes));
      const actuals = combined.rows.filter(row => selectedNodes.has(row.node) && row.localDate >= inputStartDate && row.localDate <= selected.endDate);
      const forecasts = selected.forecastMode === 'external'
        ? await readResearchRecord<ForecastBatch>(selected.forecastBatchId || '', 'forecast') : undefined;
      const generatedAt = new Date().toISOString();
      const input: EngineInput = {...selected,actuals,forecasts,generatedAt};
      if (jsonBytes(input)>5_000_000) throw new ResearchError('INPUT_TOO_LARGE','选定的数据版本过多，请缩短日期或减少节点。',413);
      const result = runStrategy(input);
      const priceNotes = archives.flatMap(a=>a.warnings);
      const provenanceNote = combined.overlaps ? `所选价格版本有 ${combined.overlaps} 个重叠节点小时，采用获取时间最新的所选版本；完整输入已固化在运行记录。` : '本次实际价格、预测输入及参数均已固化，可下载 JSON 证据包。';
      const sliceNote = actuals.length < combined.rows.length ? `本次策略仅需 ${inputStartDate} 至 ${selected.endDate} PT 的所选节点数据，固化 ${actuals.length} 个节点小时；完整所选价格档案共 ${combined.rows.length} 行。` : null;
      result.warnings = [...new Set([...result.warnings,provenanceNote,...(sliceNote ? [sliceNote] : []),...priceNotes])];
      const inputDigest = await sha256(JSON.stringify(input));
      const resultDigest = await sha256(JSON.stringify(result));
      const digest = await sha256(JSON.stringify({inputDigest,resultDigest}));
      const run: StrategyRun = {id:`run_${crypto.randomUUID()}`,name:`${selected.mode==='backtest'?'历史回测':'单日模拟'} · ${selected.startDate}${selected.endDate!==selected.startDate?` 至 ${selected.endDate}`:''}`,createdAt:generatedAt,digest,inputDigest,request:selected,result,provenance:{priceArchives:archives.map(a=>({id:a.id,digest:a.digest,fetchedAt:a.fetchedAt,sourceUrls:a.sourceUrls})),forecastBatch:forecasts?{id:forecasts.id,digest:forecasts.digest,createdAt:forecasts.createdAt,source:forecasts.source}:null},evidence:{input,resultDigest}};
      await saveResearchRecord({id:run.id,kind:'run',name:run.name,createdAt:run.createdAt,digest,startDate:selected.startDate,endDate:selected.endDate,forecastMode:selected.forecastMode,mode:selected.mode,netPnl:result.plans[0]?.metrics.netPnl??null},run);
      return respond({ok:true,run});
    }
    if (body.action === 'replay') {
      if (typeof body.id !== 'string') throw new ResearchError('INVALID_ID','请选择一份运行记录。');
      const run = await readResearchRecord<StrategyRun>(body.id,'run');
      if (!run.evidence) throw new ResearchError('INPUT_MISSING','该记录没有完整输入，无法重放。',409);
      const inputDigest = await sha256(JSON.stringify(run.evidence.input));
      if (inputDigest !== run.inputDigest) throw new ResearchError('INPUT_DIGEST_MISMATCH','输入校验值不一致，已停止重放。',409);
      const result = runStrategy(run.evidence.input);
      // These provenance notes do not depend on the computation and are saved with the record.
      result.warnings = [...run.result.warnings];
      const resultDigest = await sha256(JSON.stringify(result));
      return respond({ok:true,run,identical:resultDigest===run.evidence.resultDigest,replayedAt:new Date().toISOString(),originalEngineVersion:run.result.version,currentEngineVersion:result.version,engineVersionChanged:run.result.version!==result.version});
    }
    throw new ResearchError('INVALID_ACTION','不支持的研究操作。');
  } catch (error) { return fail(error); }
}
