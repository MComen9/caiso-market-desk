export type StrategyId = 'normal' | 'high_conf' | 'half' | 'aggressive' | 'always_inc' | 'cap_only' | 'contrarian';
export type ForecastMode = 'baseline' | 'external' | 'scenario';
export type TimingPolicy = 'declared' | 'recorded';
export interface ActualHour {
  node: string; startUtc: string; endUtc: string; localDate: string; localHour: string; utcOffset: string;
  dam: number | null; fmm: number | null; fmmCount: number; paired: boolean;
}
export interface PriceArchive {
  id: string; name: string; createdAt: string; startDate: string; endDate: string; nodes: string[];
  rows: ActualHour[]; sourceUrls: string[]; fetchedAt: string; digest: string; warnings: string[];
}
export interface ForecastPoint {
  node: string; startUtc: string; predictedDa: number; predictedSpread: number; sigma: number | null;
  issuedAt: string; modelVersion: string;
  trainingEndUtc?: string; sampleCount?: number;
}
export interface ForecastBatch {
  id: string; name: string; createdAt: string; source: string; modelVersion: string;
  digest: string; points: ForecastPoint[]; warnings: string[];
}
export interface StrategyConfig {
  name: string; strategy: StrategyId; nodes: string[]; selection: 'manual' | 'ranked'; nodeCount: number;
  totalMWh: number; perCellMWh: number; perNodeMWh: number; maxCells: number;
  k: number; quoteOffset: number; maxAdverseSpread: number; minWinRate: number; minEv: number;
  minNodeSamples: number; feePerMWh: number; tieFill: boolean;
  aggressiveBuyQuote: number; aggressiveSellQuote: number;
}
export interface BaselineSettings { lookbackDays: number; minSamples: number; lagDays: number }
export interface ScenarioSettings { predictedDa: number; predictedSpread: number; sigma: number | null }
export interface StrategyRequest {
  mode: 'single' | 'backtest'; startDate: string; endDate: string;
  forecastMode: ForecastMode; timingPolicy: TimingPolicy; cutoffTime: string;
  baseline: BaselineSettings; scenario: ScenarioSettings;
  configs: StrategyConfig[]; priceArchiveIds: string[]; forecastBatchId?: string;
}
export interface EngineInput extends StrategyRequest {
  actuals: ActualHour[]; forecasts?: ForecastBatch; generatedAt: string;
}
export type CellStatus = 'filled' | 'not_filled' | 'missing_actual' | 'tie_excluded';
export interface StrategyCell {
  node: string; startUtc: string; endUtc: string; localDate: string; localHour: string; utcOffset: string;
  side: 'INC' | 'DEC'; quote: number; mwh: number; predictedDa: number; predictedSpread: number;
  sigma: number | null; expectedPnl: number; actualDa: number | null; actualFmm: number | null;
  grossPnl: number | null; fees: number | null; netPnl: number | null; status: CellStatus;
  forecastIssuedAt: string; forecastModel: string; sampleCount: number | null;
  trainingEndUtc: string | null;
}
export interface NodeStatistic {
  node: string; samples: number; winRate: number | null; ev: number | null;
  profitFactor: number | null; selected: boolean; reason: string;
}
export interface StrategyDay {
  date: string; decisionAsOfUtc: string; status: 'complete' | 'partial' | 'no_signals' | 'no_forecast';
  expectedHours: number; forecastHours: number; availableActualHours: number;
  selectedNodes: string[]; nodeStats: NodeStatistic[]; cells: StrategyCell[];
  plannedMWh: number; unallocatedMWh: number; filledMWh: number; settledMWh: number;
  expectedPnl: number; grossPnl: number | null; fees: number | null; netPnl: number | null;
  knownNetPnl: number; exclusions: Record<string, number>; warnings: string[];
}
export interface StrategyMetrics {
  days: number; evaluatedDays: number; incompleteDays: number; noSignalDays: number;
  plannedMWh: number; filledMWh: number; settledMWh: number;
  grossPnl: number | null; fees: number | null; netPnl: number | null; expectedPnl: number;
  winRate: number | null; perMWh: number | null; profitFactor: number | null;
  maxDrawdown: number | null; winningCells: number; settledCells: number;
  forecastCoverage: number; actualCoverage: number;
}
export interface StrategyPlanResult {
  config: StrategyConfig; days: StrategyDay[]; metrics: StrategyMetrics;
  equity: Array<{date: string; cumulative: number | null; daily: number | null}>;
}
export interface EngineResult {
  version: string; generatedAt: string; classification: string; timingLabel: string;
  startDate: string; endDate: string; forecastMode: ForecastMode; plans: StrategyPlanResult[];
  warnings: string[];
}
export interface StrategyRun {
  id: string; name: string; createdAt: string; digest: string; inputDigest: string;
  request: StrategyRequest; result: EngineResult;
  provenance: { priceArchives: Array<{id: string; digest: string; fetchedAt: string; sourceUrls: string[]}>; forecastBatch: {id: string; digest: string; createdAt: string; source: string} | null };
  evidence?: { input: EngineInput; resultDigest: string };
}
export interface RecordSummary {
  id: string; kind: 'price' | 'forecast' | 'run'; name: string; createdAt: string; digest: string;
  startDate?: string; endDate?: string; count?: number; nodes?: string[]; source?: string;
  forecastMode?: ForecastMode; mode?: 'single' | 'backtest'; netPnl?: number | null;
}
export interface StrategyCatalog { ok: boolean; persistent: boolean; message?: string; prices: RecordSummary[]; forecasts: RecordSummary[]; runs: RecordSummary[] }
export const ENGINE_VERSION = 'caiso-strategy-2.0.1';
export const STRATEGIES: Record<StrategyId, {label: string; description: string}> = {
  normal: {label: '顺势', description: '正预测价差选 DEC，负预测价差选 INC；应用 k × 波动门槛。'},
  high_conf: {label: '高门槛', description: '顺势方向，实际门槛为 max(k, 1.5) × 波动；不代表已校准胜率。'},
  half: {label: '半仓', description: '顺势方向，每日预算减半，仍遵守每个时段至少 1 MWh 的研究约束。'},
  aggressive: {label: '积极报价', description: '顺势方向，使用配置的固定买卖报价；不保证成交。'},
  always_inc: {label: '固定 INC', description: '固定虚拟供给方向；仍应用信号门槛与最大不利价差约束。'},
  cap_only: {label: '固定 DEC', description: '固定虚拟需求方向；仍应用信号门槛与最大不利价差约束。'},
  contrarian: {label: '逆向', description: '反转预测方向；仍应用信号门槛与最大不利价差约束。'},
};
export const DEFAULT_CONFIG: StrategyConfig = {
  name: '方案 A', strategy: 'normal', nodes: ['TH_NP15_GEN-APND', 'TH_SP15_GEN-APND', 'TH_ZP26_GEN-APND'],
  selection: 'manual', nodeCount: 3, totalMWh: 12, perCellMWh: 2, perNodeMWh: 6, maxCells: 12,
  k: 0.5, quoteOffset: 10, maxAdverseSpread: 10, minWinRate: 50, minEv: 0,
  minNodeSamples: 12, feePerMWh: 0, tieFill: false, aggressiveBuyQuote: 1000, aggressiveSellQuote: -150,
};
export const DEFAULT_BASELINE: BaselineSettings = {lookbackDays: 28, minSamples: 3, lagDays: 2};
