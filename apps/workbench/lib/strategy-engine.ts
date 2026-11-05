import { addDays, enumerateHours, localParts } from './time';
import { forecastTimestamp, normalizeForecastPoints } from './strategy-forecast';
import {
  DEFAULT_BASELINE, DEFAULT_CONFIG, ENGINE_VERSION, STRATEGIES,
  type ActualHour, type EngineInput, type EngineResult, type ForecastPoint, type NodeStatistic,
  type StrategyCell, type StrategyConfig, type StrategyDay, type StrategyPlanResult, type StrategyRequest,
} from './strategy-types';

const EPS = 1e-8;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const numberKey = (node: string, startUtc: string) => `${node}|${startUtc}`;
const NODE = /^[A-Z0-9][A-Z0-9_.-]{1,99}$/;
const round = (value: number) => Math.round(value * 1e9) / 1e9;
type Hour = ReturnType<typeof enumerateHours>[number];
type Candidate = {node: string; hour: Hour; forecast: ForecastPoint; side: 'INC' | 'DEC'; quote: number; score: number; weight: number; mwh: number};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}
function dateValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} 需要 YYYY-MM-DD 格式。`);
  const ms = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error(`${label} 日期不存在。`);
  return value;
}
function bounded(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (!finite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(`${label} 必须是 ${min}–${max} 范围内的${integer ? '整数' : '有限数值'}。`);
  return value;
}
function shortString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 需要 1–${max} 字符。`);
  return value.trim();
}

export function validateStrategyRequest(value: unknown): StrategyRequest {
  const raw = object(value, '策略请求');
  const startDate = dateValue(raw.startDate, '开始日期'), endDate = dateValue(raw.endDate, '结束日期');
  const days = (Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86400000 + 1;
  if (days < 1 || days > 31) throw new Error('每次运行的评估区间需为 1–31 个交易日；训练价格可覆盖更早日期。');
  if (raw.mode !== 'single' && raw.mode !== 'backtest') throw new Error('请选择单日模拟或历史回测。');
  if (raw.mode === 'single' && startDate !== endDate) throw new Error('单日模拟的开始和结束日期必须相同。');
  if (!['baseline', 'external', 'scenario'].includes(String(raw.forecastMode))) throw new Error('请选择有效的预测来源。');
  if (raw.forecastMode === 'scenario' && raw.mode !== 'single') throw new Error('手工情景仅用于单日试算，不能标作按时点历史回测。');
  if (raw.timingPolicy !== 'declared' && raw.timingPolicy !== 'recorded') throw new Error('请选择声明发布时间或平台归档时间口径。');
  const cutoffTime = typeof raw.cutoffTime === 'string' ? raw.cutoffTime : '09:55';
  if (!/^(0[0-9]):[0-5][0-9]$/.test(cutoffTime)) throw new Error('决策截点需为前一日 00:00–09:59 PT，早于通常的 10:00 日前市场关闭。');
  const baselineRaw = {...DEFAULT_BASELINE, ...object(raw.baseline ?? {}, '历史基线设置')};
  const baseline = {
    lookbackDays: bounded(baselineRaw.lookbackDays, '基线回看天数', 3, 90, true),
    minSamples: bounded(baselineRaw.minSamples, '同小时最少历史日数', 3, 90, true),
    lagDays: bounded(baselineRaw.lagDays, '基线保守滞后天数', 2, 30, true),
  };
  if (baseline.minSamples > baseline.lookbackDays) throw new Error('最少历史日数不能大于回看天数。');
  const scenarioRaw = object(raw.scenario ?? {predictedDa: 40, predictedSpread: 5, sigma: 8}, '情景设置');
  const scenario = {
    predictedDa: bounded(scenarioRaw.predictedDa, '情景 DA 价格', -100000, 100000),
    predictedSpread: bounded(scenarioRaw.predictedSpread, '情景 FMM−DA 价差', -100000, 100000),
    sigma: scenarioRaw.sigma === null ? null : bounded(scenarioRaw.sigma, '情景波动值', 0, 100000),
  };
  if (!Array.isArray(raw.configs) || !raw.configs.length || raw.configs.length > 2) throw new Error('每次可比较 1–2 个策略方案。');
  const configs = raw.configs.map((value, index): StrategyConfig => {
    const cfg = {...DEFAULT_CONFIG, ...object(value, `方案 ${index + 1}`)};
    if (!Object.hasOwn(STRATEGIES, String(cfg.strategy))) throw new Error(`方案 ${index + 1} 的策略不存在。`);
    if (!Array.isArray(cfg.nodes) || !cfg.nodes.length || cfg.nodes.length > 6 || cfg.nodes.some(node => typeof node !== 'string' || !NODE.test(node.trim().toUpperCase())))
      throw new Error(`方案 ${index + 1} 需要 1–6 个有效节点。`);
    const nodes = [...new Set(cfg.nodes.map(node => node.trim().toUpperCase()))];
    if (cfg.selection !== 'manual' && cfg.selection !== 'ranked') throw new Error('节点选择方式无效。');
    if (typeof cfg.tieFill !== 'boolean') throw new Error('相同价格成交假设必须为布尔值。');
    return {
      name: shortString(cfg.name, '方案名称', 80), strategy: cfg.strategy as StrategyConfig['strategy'], nodes,
      selection: cfg.selection, nodeCount: bounded(cfg.nodeCount, '最多选择节点数', 1, 6, true),
      totalMWh: bounded(cfg.totalMWh, '每日电量预算', 1, 10000), perCellMWh: bounded(cfg.perCellMWh, '单节点小时电量上限', 1, 10000),
      perNodeMWh: bounded(cfg.perNodeMWh, '单节点每日电量上限', 1, 10000), maxCells: bounded(cfg.maxCells, '每日最多时段数', 1, 150, true),
      k: bounded(cfg.k, '信号门槛 k', 0, 10), quoteOffset: bounded(cfg.quoteOffset, '报价偏移', 0, 10000),
      maxAdverseSpread: bounded(cfg.maxAdverseSpread, '最大预测不利价差', 0, 10000), minWinRate: bounded(cfg.minWinRate, '节点最低历史胜率', 0, 100),
      minEv: bounded(cfg.minEv, '节点最低历史单位损益', 0, 100000), minNodeSamples: bounded(cfg.minNodeSamples, '节点最少已评估信号数', 1, 10000, true),
      feePerMWh: bounded(cfg.feePerMWh, '费用假设', 0, 10000), tieFill: cfg.tieFill,
      aggressiveBuyQuote: bounded(cfg.aggressiveBuyQuote, '积极报价 DEC 买价', -100000, 100000),
      aggressiveSellQuote: bounded(cfg.aggressiveSellQuote, '积极报价 INC 卖价', -100000, 100000),
    };
  });
  if (!Array.isArray(raw.priceArchiveIds) || !raw.priceArchiveIds.length || raw.priceArchiveIds.length > 24 || raw.priceArchiveIds.some(id => typeof id !== 'string' || id.length > 150 || !id.trim()))
    throw new Error('请选择 1–24 份已保存价格档案。');
  const priceArchiveIds = [...new Set(raw.priceArchiveIds as string[])];
  const forecastBatchId = raw.forecastBatchId === undefined || raw.forecastBatchId === '' ? undefined : shortString(raw.forecastBatchId, '预测批次 ID', 150);
  if (raw.forecastMode === 'external' && !forecastBatchId) throw new Error('请先导入并选择外部预测批次。');
  return {mode: raw.mode, startDate, endDate, forecastMode: raw.forecastMode as StrategyRequest['forecastMode'], timingPolicy: raw.timingPolicy,
    cutoffTime, baseline, scenario, configs, priceArchiveIds, ...(forecastBatchId ? {forecastBatchId} : {})};
}

/** A local wall-clock cutoff, including the day after either DST transition. */
export function decisionAsOf(date: string, cutoffTime = '09:55'): string {
  dateValue(date, '交易日期');
  if (!/^(0[0-9]):[0-5][0-9]$/.test(cutoffTime)) throw new Error('决策截点必须位于前一日 00:00–09:59 PT。');
  const previous = addDays(date, -1), wallHour = `${cutoffTime.slice(0, 2)}:00`;
  const hour = enumerateHours(previous, previous).find(value => value.localHour === wallHour);
  if (!hour) throw new Error(`${previous} PT 的 ${cutoffTime} 因夏令时跳时不存在，请选择 03:00 之后的截点。`);
  return new Date(Date.parse(hour.startUtc) + Number(cutoffTime.slice(3)) * 60000).toISOString();
}

function normalizeActuals(raw: ActualHour[]): {rows: ActualHour[]; conflicts: number} {
  if (!Array.isArray(raw) || raw.length > 20000) throw new Error('最多支持 20,000 个价格小时；请缩小节点或日期范围。');
  const seen = new Map<string, ActualHour>(); let conflicts = 0;
  for (const row of raw) {
    if (!row || typeof row.node !== 'string' || !NODE.test(row.node)) throw new Error('价格档案包含无效节点。');
    const startUtc = forecastTimestamp(row.startUtc, '价格小时起点', true), endUtc = forecastTimestamp(row.endUtc, '价格小时终点', true);
    if (Date.parse(endUtc) - Date.parse(startUtc) !== 3600000) throw new Error('策略输入必须为完整的一小时区间。');
    for (const value of [row.dam, row.fmm]) if (value !== null && !finite(value)) throw new Error('价格缺失必须为 null，不能使用 NaN 或无穷值。');
    const local = localParts(startUtc), dam = finite(row.dam) ? row.dam : null;
    const fmm = row.fmmCount === 4 && finite(row.fmm) && !(row.paired === false && dam !== null) ? row.fmm : null;
    const normalized: ActualHour = {node: row.node, startUtc, endUtc, localDate: local.localDate, localHour: local.localHour, utcOffset: local.utcOffset,
      dam, fmm, fmmCount: row.fmmCount, paired: dam !== null && fmm !== null};
    const key = numberKey(row.node, startUtc), old = seen.get(key);
    if (old && (old.dam !== normalized.dam || old.fmm !== normalized.fmm || old.fmmCount !== normalized.fmmCount)) {
      seen.set(key, {...normalized, dam: null, fmm: null, fmmCount: 0, paired: false}); conflicts++;
    } else if (!old) seen.set(key, normalized);
  }
  return {rows: [...seen.values()].sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.node.localeCompare(b.node)), conflicts};
}

function decision(forecast: ForecastPoint, config: StrategyConfig): {side: 'INC' | 'DEC'; quote: number; score: number; weight: number} | string {
  const spread = forecast.predictedSpread;
  let side: 'INC' | 'DEC';
  if (config.strategy === 'always_inc') side = 'INC';
  else if (config.strategy === 'cap_only') side = 'DEC';
  else {
    if (spread === 0) return '预测价差为零';
    side = spread > 0 ? 'DEC' : 'INC';
    if (config.strategy === 'contrarian') side = side === 'DEC' ? 'INC' : 'DEC';
  }
  const k = config.strategy === 'high_conf' ? Math.max(config.k, 1.5) : config.k;
  if (k > 0 && (!finite(forecast.sigma) || forecast.sigma <= 0)) return '缺少正的波动值';
  if (k > 0 && Math.abs(spread) + EPS < k * forecast.sigma!) return '未达到信号门槛';
  if ((side === 'DEC' ? spread : -spread) < -config.maxAdverseSpread - EPS) return '超过最大不利价差';
  const quote = config.strategy === 'aggressive'
    ? side === 'DEC' ? config.aggressiveBuyQuote : config.aggressiveSellQuote
    : forecast.predictedDa + (side === 'DEC' ? config.quoteOffset : -config.quoteOffset);
  const score = Math.abs(spread) / (finite(forecast.sigma) && forecast.sigma > 0 ? forecast.sigma : 1);
  return {side, quote, score, weight: Math.max(.12, score - k + .12)};
}

/** Greedy minimum-size admission followed by bounded weighted water filling. */
function allocate(candidates: Candidate[], config: StrategyConfig): {cells: Candidate[]; unallocated: number} {
  const budget = config.totalMWh * (config.strategy === 'half' ? .5 : 1);
  let remaining = budget;
  const nodeUsed = new Map<string, number>(), admitted: Candidate[] = [];
  candidates.sort((a, b) => b.score - a.score || a.hour.startUtc.localeCompare(b.hour.startUtc) || a.node.localeCompare(b.node));
  for (const candidate of candidates) {
    if (admitted.length >= config.maxCells || remaining < 1 - EPS) break;
    const used = nodeUsed.get(candidate.node) ?? 0;
    if (config.perNodeMWh - used < 1 - EPS) continue;
    admitted.push({...candidate, mwh: 1}); nodeUsed.set(candidate.node, used + 1); remaining -= 1;
  }
  for (let iteration = 0; iteration < 150 && remaining > EPS; iteration++) {
    const active = admitted.filter(cell => config.perCellMWh - cell.mwh > EPS && config.perNodeMWh - (nodeUsed.get(cell.node) ?? 0) > EPS);
    if (!active.length) break;
    const weights = sum(active.map(cell => cell.weight)); let taken = 0;
    for (const cell of active) {
      const room = Math.min(config.perCellMWh - cell.mwh, config.perNodeMWh - (nodeUsed.get(cell.node) ?? 0));
      const add = Math.max(0, Math.min(remaining * cell.weight / weights, room));
      cell.mwh += add; nodeUsed.set(cell.node, (nodeUsed.get(cell.node) ?? 0) + add); taken += add;
    }
    remaining -= taken;
    if (taken < EPS) break;
  }
  return {cells: admitted.map(cell => ({...cell, mwh: round(cell.mwh)})), unallocated: round(Math.max(0, budget - sum(admitted.map(cell => cell.mwh))))};
}

function evaluate(candidate: Candidate, actual: ActualHour | undefined, config: StrategyConfig): StrategyCell {
  const {forecast, hour} = candidate, sign = candidate.side === 'DEC' ? 1 : -1;
  const result: StrategyCell = {
    node: candidate.node, startUtc: hour.startUtc, endUtc: hour.endUtc, localDate: hour.localDate, localHour: hour.localHour, utcOffset: hour.utcOffset,
    side: candidate.side, quote: candidate.quote, mwh: candidate.mwh, predictedDa: forecast.predictedDa, predictedSpread: forecast.predictedSpread,
    sigma: forecast.sigma, expectedPnl: candidate.mwh * sign * forecast.predictedSpread,
    actualDa: actual?.dam ?? null, actualFmm: actual?.fmm ?? null, grossPnl: null, fees: null, netPnl: null, status: 'missing_actual',
    forecastIssuedAt: forecast.issuedAt, forecastModel: forecast.modelVersion, sampleCount: forecast.sampleCount ?? null, trainingEndUtc: forecast.trainingEndUtc ?? null,
  };
  if (!finite(result.actualDa)) return result;
  const difference = candidate.side === 'DEC' ? candidate.quote - result.actualDa : result.actualDa - candidate.quote;
  const tied = Math.abs(difference) <= EPS;
  if (tied && !config.tieFill) return {...result, status: 'tie_excluded', grossPnl: 0, fees: 0, netPnl: 0};
  if (difference < -EPS) return {...result, status: 'not_filled', grossPnl: 0, fees: 0, netPnl: 0};
  if (!finite(result.actualFmm) || actual?.fmmCount !== 4) return result;
  const grossPnl = candidate.mwh * sign * (result.actualFmm - result.actualDa), fees = candidate.mwh * config.feePerMWh;
  return {...result, status: 'filled', grossPnl, fees, netPnl: grossPnl - fees};
}

export function runStrategy(input: EngineInput): EngineResult {
  const request = validateStrategyRequest(input), generatedAt = forecastTimestamp(input.generatedAt, '运行时间');
  const normalized = normalizeActuals(input.actuals), actuals = normalized.rows;
  const actualIndex = new Map(actuals.map(row => [numberKey(row.node, row.startUtc), row]));
  const hourlyHistory = new Map<string, Map<string, ActualHour[]>>();
  const nodeHistory = new Map<string, ActualHour[]>();
  for (const row of actuals) {
    if (!row.paired) continue;
    const key = `${row.node}|${row.localHour}`;
    if (!hourlyHistory.has(key)) hourlyHistory.set(key, new Map());
    const days = hourlyHistory.get(key)!, day = days.get(row.localDate) ?? []; day.push(row); days.set(row.localDate, day);
    const history = nodeHistory.get(row.node) ?? []; history.push(row); nodeHistory.set(row.node, history);
  }
  const externalIndex = new Map<string, ForecastPoint[]>();
  let forecastRecordedAt: string | null = null;
  if (request.forecastMode === 'external') {
    if (!input.forecasts || input.forecasts.id !== request.forecastBatchId) throw new Error('所选预测批次不存在或与请求不一致。');
    forecastRecordedAt = forecastTimestamp(input.forecasts.createdAt, '预测归档时间');
    const points = normalizeForecastPoints(input.forecasts.points, input.forecasts.modelVersion);
    for (const point of points) { const key = numberKey(point.node, point.startUtc), group = externalIndex.get(key) ?? []; group.push(point); externalIndex.set(key, group); }
    for (const group of externalIndex.values()) group.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }
  const forecastCache = new Map<string, ForecastPoint | null>();
  const cutoffCache = new Map<string, string>();
  const getCutoff = (date: string) => {
    if (!cutoffCache.has(date)) cutoffCache.set(date, decisionAsOf(date, request.cutoffTime));
    return cutoffCache.get(date)!;
  };
  const getForecast = (node: string, hour: Hour): ForecastPoint | null => {
    const key = numberKey(node, hour.startUtc);
    if (forecastCache.has(key)) return forecastCache.get(key)!;
    const cutoff = getCutoff(hour.localDate);
    let point: ForecastPoint | null = null;
    if (request.forecastMode === 'scenario') {
      point = {node, startUtc: hour.startUtc, ...request.scenario, issuedAt: generatedAt, modelVersion: 'manual-scenario/v1'};
    } else if (request.forecastMode === 'external') {
      if (request.timingPolicy !== 'recorded' || forecastRecordedAt! <= cutoff)
        point = externalIndex.get(key)?.find(value => value.issuedAt <= cutoff) ?? null;
    } else {
      const latest = addDays(hour.localDate, -request.baseline.lagDays), earliest = addDays(latest, 1 - request.baseline.lookbackDays);
      const history = hourlyHistory.get(`${node}|${hour.localHour}`);
      const days: Array<{da: number; spread: number; end: string}> = [];
      for (const [date, rows] of history ?? []) {
        if (date < earliest || date > latest) continue;
        const eligible = rows.filter(row => row.endUtc <= cutoff);
        if (!eligible.length) continue;
        // Both fall-back folds count as one historical date, never two samples.
        days.push({da: avg(eligible.map(row => row.dam!)), spread: avg(eligible.map(row => row.fmm! - row.dam!)), end: eligible.map(row => row.endUtc).sort().at(-1)!});
      }
      if (days.length >= request.baseline.minSamples) {
        const predictedSpread = avg(days.map(day => day.spread));
        point = {node, startUtc: hour.startUtc, predictedDa: avg(days.map(day => day.da)), predictedSpread,
          sigma: Math.sqrt(sum(days.map(day => (day.spread - predictedSpread) ** 2)) / (days.length - 1)),
          issuedAt: generatedAt, modelVersion: 'historical-same-hour/v1', sampleCount: days.length,
          trainingEndUtc: days.map(day => day.end).sort().at(-1)!};
      }
    }
    forecastCache.set(key, point); return point;
  };
  const hourFor = (row: ActualHour): Hour => ({startUtc: row.startUtc, endUtc: row.endUtc, ...localParts(row.startUtc)});
  const historicalCache = new Map<string, Array<{date: string; endUtc: string; pnl: number}>>();
  function nodeStats(date: string, config: StrategyConfig, configIndex: number): NodeStatistic[] {
    const cutoff = getCutoff(date), latest = addDays(date, -request.baseline.lagDays), earliest = addDays(latest, 1 - request.baseline.lookbackDays);
    const stats = config.nodes.map((node): NodeStatistic => {
      if (config.selection === 'manual') return {node, samples: 0, winRate: null, ev: null, profitFactor: null, selected: true, reason: '手动选择；不使用历史胜率筛选'};
      const cacheKey = `${configIndex}|${node}`;
      let history = historicalCache.get(cacheKey);
      if (!history) {
        history = [];
        for (const row of nodeHistory.get(node) ?? []) {
          const hour = hourFor(row), forecast = getForecast(node, hour);
          if (!forecast) continue;
          const signal = decision(forecast, config); if (typeof signal === 'string') continue;
          const cell = evaluate({node, hour, forecast, ...signal, mwh: 1}, row, config);
          if (cell.status === 'filled' && finite(cell.netPnl)) history.push({date: row.localDate, endUtc: row.endUtc, pnl: cell.netPnl});
        }
        historicalCache.set(cacheKey, history);
      }
      const eligible = history.filter(row => row.date >= earliest && row.date <= latest && row.endUtc <= cutoff);
      const values = eligible.map(row => row.pnl), wins = values.filter(value => value > 0), losses = values.filter(value => value < 0);
      const samples = values.length, winRate = samples ? wins.length / samples * 100 : null, ev = samples ? avg(values) : null;
      const profitFactor = losses.length ? sum(wins) / -sum(losses) : null;
      const reason = samples < config.minNodeSamples ? `样本不足 ${samples}/${config.minNodeSamples}`
        : winRate! + EPS < config.minWinRate ? '历史胜率低于门槛'
        : ev! <= 0 || ev! + EPS < config.minEv ? '历史单位损益未达到正值门槛' : '满足硬门槛';
      return {node, samples, winRate, ev, profitFactor, selected: false, reason};
    });
    if (config.selection === 'ranked') {
      const eligible = stats.filter(stat => stat.reason === '满足硬门槛').sort((a, b) => b.ev! - a.ev! || b.winRate! - a.winRate! || b.samples - a.samples || a.node.localeCompare(b.node));
      eligible.slice(0, config.nodeCount).forEach(stat => { stat.selected = true; stat.reason = '滚动统计入选'; });
      eligible.slice(config.nodeCount).forEach(stat => { stat.reason = '满足门槛，但超出节点数限制'; });
    }
    return stats;
  }

  const dates: string[] = [];
  for (let date = request.startDate; date <= request.endDate; date = addDays(date, 1)) dates.push(date);
  const plans: StrategyPlanResult[] = request.configs.map((config, configIndex) => {
    const days: StrategyDay[] = dates.map(date => {
      const hours = enumerateHours(date, date), stats = nodeStats(date, config, configIndex), selectedNodes = stats.filter(stat => stat.selected).map(stat => stat.node);
      const selected = new Set(selectedNodes), exclusions: Record<string, number> = {}, candidates: Candidate[] = [];
      const excluded = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
      let forecastHours = 0, availableActualHours = 0;
      for (const node of config.nodes) for (const hour of hours) {
        if (actualIndex.get(numberKey(node, hour.startUtc))?.paired) availableActualHours++;
        const forecast = getForecast(node, hour);
        if (!forecast) { excluded(request.forecastMode === 'baseline' ? '历史同小时样本不足' : '缺少截点前可用预测'); continue; }
        forecastHours++;
        if (!selected.has(node)) { excluded('节点未通过筛选'); continue; }
        const signal = decision(forecast, config);
        if (typeof signal === 'string') { excluded(signal); continue; }
        candidates.push({node, hour, forecast, ...signal, mwh: 0});
      }
      // No target-day actual value participates in admission, score, direction, quote, or quantity.
      const allocated = allocate(candidates, config);
      if (candidates.length > allocated.cells.length) exclusions['电量、节点或时段上限未分配'] = candidates.length - allocated.cells.length;
      const cells = allocated.cells.map(candidate => evaluate(candidate, actualIndex.get(numberKey(candidate.node, candidate.hour.startUtc)), config));
      const expectedHours = hours.length * config.nodes.length;
      // A zero-allocation future plan is not an already observed zero-return day.
      // Use the frozen run timestamp, never the wall clock, so replay is stable.
      // The UTC end comes from PT enumeration and therefore honors 23/25-hour days.
      const pendingZeroPlan = !cells.length && Date.parse(generatedAt) < Date.parse(hours.at(-1)!.endUtc);
      const incomplete = forecastHours < expectedHours || cells.some(cell => cell.status === 'missing_actual') || pendingZeroPlan;
      const status: StrategyDay['status'] = forecastHours === 0 ? 'no_forecast' : incomplete ? 'partial' : !cells.length ? 'no_signals' : 'complete';
      const evaluated = status === 'complete' || status === 'no_signals';
      const warnings: string[] = [];
      if (forecastHours < expectedHours) warnings.push(`预测覆盖 ${forecastHours}/${expectedHours} 个节点小时；本日不计入完整日损益。`);
      if (pendingZeroPlan) warnings.push('在冻结运行时点，该 PT 交易日尚未结束；当前未分配电量不代表已实现的零收益，实际损益与费用保持为空，等待事后验证。');
      if (cells.some(cell => cell.status === 'missing_actual')) warnings.push('部分已计划时段的 DA 或 4 个 FMM 价格不完整；保留计划和已知小计，本日损益留空。');
      if (selectedNodes.length < config.nodeCount && config.selection === 'ranked') warnings.push(`仅 ${selectedNodes.length} 个节点通过硬门槛，未放宽条件补选。`);
      if (allocated.unallocated > EPS) warnings.push(`尚有 ${allocated.unallocated.toFixed(3)} MWh 未分配；由有效信号、最小 1 MWh 及仓位上限共同决定。`);
      if (cells.some(cell => cell.status === 'tie_excluded')) warnings.push('报价恰好等于 DA 的时段按未成交处理；实际边际成交及部分分配需要真实市场回执。');
      const filledMWh = sum(cells.filter(cell => {
        if (cell.status === 'filled') return true;
        if (cell.status !== 'missing_actual' || !finite(cell.actualDa)) return false;
        const difference = cell.side === 'DEC' ? cell.quote - cell.actualDa : cell.actualDa - cell.quote;
        return difference > EPS || (config.tieFill && Math.abs(difference) <= EPS);
      }).map(cell => cell.mwh));
      return {date, decisionAsOfUtc: getCutoff(date), status, expectedHours, forecastHours, availableActualHours,
        selectedNodes, nodeStats: stats, cells, plannedMWh: round(sum(cells.map(cell => cell.mwh))), unallocatedMWh: allocated.unallocated,
        filledMWh: round(filledMWh), settledMWh: round(sum(cells.filter(cell => cell.status === 'filled').map(cell => cell.mwh))),
        expectedPnl: sum(cells.map(cell => cell.expectedPnl)), grossPnl: evaluated ? sum(cells.map(cell => cell.grossPnl ?? 0)) : null,
        fees: evaluated ? sum(cells.map(cell => cell.fees ?? 0)) : null, netPnl: evaluated ? sum(cells.map(cell => cell.netPnl ?? 0)) : null,
        knownNetPnl: sum(cells.map(cell => cell.netPnl ?? 0)), exclusions, warnings};
    });
    const evaluated = days.filter(day => finite(day.netPnl)), settled = evaluated.flatMap(day => day.cells.filter(cell => cell.status === 'filled'));
    const profits = settled.map(cell => cell.netPnl!), positive = profits.filter(value => value > 0), negative = profits.filter(value => value < 0);
    let cumulative = 0, peak = 0, maxDrawdown = 0;
    const equity = days.map(day => {
      if (!finite(day.netPnl)) return {date: day.date, daily: null, cumulative: null};
      cumulative += day.netPnl; peak = Math.max(peak, cumulative); maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
      return {date: day.date, daily: day.netPnl, cumulative};
    });
    const netPnl = evaluated.length ? sum(evaluated.map(day => day.netPnl!)) : null;
    const settledMWh = sum(evaluated.map(day => day.settledMWh)), expectedHours = sum(days.map(day => day.expectedHours));
    return {config, days, equity, metrics: {
      days: days.length, evaluatedDays: evaluated.length, incompleteDays: days.length - evaluated.length, noSignalDays: days.filter(day => day.status === 'no_signals').length,
      plannedMWh: round(sum(days.map(day => day.plannedMWh))), filledMWh: round(sum(days.map(day => day.filledMWh))), settledMWh: round(settledMWh),
      grossPnl: evaluated.length ? sum(evaluated.map(day => day.grossPnl!)) : null, fees: evaluated.length ? sum(evaluated.map(day => day.fees!)) : null,
      netPnl, expectedPnl: sum(days.map(day => day.expectedPnl)), winRate: settled.length ? positive.length / settled.length * 100 : null,
      perMWh: settledMWh > 0 && netPnl !== null ? netPnl / settledMWh : null, profitFactor: negative.length ? sum(positive) / -sum(negative) : null,
      maxDrawdown: evaluated.length ? maxDrawdown : null, winningCells: positive.length, settledCells: settled.length,
      forecastCoverage: expectedHours ? sum(days.map(day => day.forecastHours)) / expectedHours : 0,
      actualCoverage: expectedHours ? sum(days.map(day => day.availableActualHours)) / expectedHours : 0,
    }};
  });
  const timingLabel = request.forecastMode === 'baseline' ? '历史重建基线 · 按日推进 · 非当时发布预测'
    : request.forecastMode === 'scenario' ? '手工情景试算 · 非历史时点预测'
    : request.timingPolicy === 'recorded' ? '平台归档截点回放 · 同时检查接收时间与声明发布时间' : '外部预测声明时间重放 · 历史存在性未经独立验证';
  const warnings = [
    '仅模拟 DA 与每小时 4 个 FMM 均价的价差部分；不包括 Forecasted Movement、其他 CAISO 结算项、信用要求、节点可交易资格或真实成交回执。',
    '报价穿过 DA 时假设全量模拟成交；等价报价按方案设置处理。未实现真实市场部分成交、价格影响及官方报价上限校验。',
    '条件预期损益是假定全部计划量成交、未扣费用的价差测算，不是经校准的成交概率预测。已评估净损益另扣用户配置的费用假设。',
    '主损益、胜率、单位损益、盈利因子及美元回撤只统计完整评估日；不完整日留空，已知小计单独保留。未计算年化 Sharpe 或资本回报率。',
    '历史价格使用所选档案版本，可能已含事后修订；本系统尚不能证明每个价格版本在模拟截点已发布。',
    `每日决策截点为前一交易日 ${request.cutoffTime} PT，是早于通常 10:00 关闭的研究假设；不是提交任何实际报价。`,
    '每个节点小时的最低计划量为 1 MWh（对一小时对应 1 MW）；数量允许非整数，仓位上限为研究参数。',
  ];
  if (request.forecastMode === 'baseline') warnings.push(`历史基线按同一 PT 小时取过去 ${request.baseline.lookbackDays} 天、至少 ${request.baseline.minSamples} 个独立历史日的均值；仅使用 D−${request.baseline.lagDays} 及之前数据。sigma 是历史价差样本波动，不代表预测置信区间。生成时间保留为真实运行时间。`);
  if (request.forecastMode === 'external') warnings.push(request.timingPolicy === 'recorded'
    ? '归档模式要求批次接收时间也不晚于各日截点；现在导入的历史预测不能用于此前的已归档回放。'
    : '声明时间来自导入文件。即使早于截点，也不能证明预测当时已生成；此结果标为事后重放。');
  if (request.configs.some(config => config.selection === 'ranked')) warnings.push('节点滚动统计采用此前可用预测的 1 MWh 模拟成交信号；逐日重算，不使用评估区间之后的数据。它是信号样本充分度，不是市场流动性。');
  if (actuals.length && new Set(actuals.map(row => row.localDate)).size < 30) warnings.push('所选价格档案不足 30 个历史日；结果适合演算与功能核验，不能据此确认稳定收益。');
  if (normalized.conflicts) warnings.push(`${normalized.conflicts} 个重复价格小时存在冲突，已作为缺失处理。`);
  return {version: ENGINE_VERSION, generatedAt, classification: '研究用策略模拟；非真实成交、非完整官方结算', timingLabel,
    startDate: request.startDate, endDate: request.endDate, forecastMode: request.forecastMode, plans, warnings};
}
