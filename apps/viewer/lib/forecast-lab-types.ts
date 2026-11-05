import type { ForecastBatch, ForecastPoint } from './strategy-types';

export interface ForecastMetric {
  mae: number; rmse: number; bias: number; n: number;
  signAccuracy?: number | null; signalRate?: number; conditionalSignAccuracy?: number | null;
}
export interface ForecastMetrics { da: ForecastMetric; spread: ForecastMetric }
export interface ModelCandidate {
  id: string; label: string; family: string; params: Record<string, unknown>;
  validation: ForecastMetrics; calibration: ForecastMetrics; holdout: ForecastMetrics;
}
export interface ModelSelection { id: string; label: string; validationMae: number; baselineMae: number; improvementPct: number }
export interface ForecastExperiment {
  schemaVersion: number; experimentId: string; modelVersion: string; generatedAt: string; classification: string;
  sample: {startDate: string; endDate: string; days: number; rows: number; nodes: string[]; inputSha256: string; archiveDigest: string};
  splits: {validation: DateSplit; calibration: DateSplit; holdout: DateSplit; purgedDates: string[]};
  selectedModels: {da: ModelSelection; spread: ModelSelection}; candidates: ModelCandidate[];
  holdout: {selected: ForecastMetrics; baseline: ForecastMetrics; daily: Array<{date: string; daMae: number; spreadMae: number; signAccuracy: number | null}>;
    byNode: Array<{node: string; da: ForecastMetric; spread: ForecastMetric}>;
    intervals: {daCoverage80: number; spreadCoverage80: number; calibrationDays: number}};
  forecast: {targetDate: string; issuedAt: string | null; decisionAsOfUtc: string; trainingThrough: string; trainingEndUtc: string | null; rows: number; status: string; reason?: string | null; url: string};
  method: {selectionRule: string; featureDelayDays: number; seed: number; featureNames: string[]; calibration: string; training: string};
  featureAudit: Array<{source: string; status: string; reason: string}>;
  warnings: string[]; sources: Array<{title: string; url: string}>;
  artifacts: {forward: string; history: string; walkForward: string; csv: string; models: string};
  optimization?: ForecastOptimization;
}
export interface DateSplit {startDate: string; endDate: string; days: number}
export interface ModelForecastPoint extends ForecastPoint {
  endUtc: string; localDate: string; localHour: string; utcOffset: string;
  predictedFmm: number; decisionAsOfUtc: string; calibrationCount: number;
  daLow80: number | null; daHigh80: number | null; spreadLow80: number | null; spreadHigh80: number | null;
  actualDa: number | null; actualFmm: number | null; actualSpread: number | null;
  split: string; classification: string;
}
export interface ModelForecastBundle extends Omit<ForecastBatch, 'points'> {
  schemaVersion: number; generatedAt: string; classification: string;
  points: ModelForecastPoint[];
}
export interface ForecastSimulation {
  engineVersion: string; generatedAt: string; forecastDate: string; forecastDigest: string; historyDigest: string;
  config: {strat: string; k: number; total: number; capPer: number; capNode: number; maxCells: number; dp: number; feePerMWh: number};
  forward: {date: string; status: string; pnl: null; expected: number; gross: number; unallocatedMWh: number; forecastHours: number; expectedHours: number} | null;
  forwardStatus?: string;
  forwardReason?: string;
  developmentClass?: string;
  holdout: {total: number; maxdd: number; ndays: number; evaluatedDays: number; incompleteDays: number; noSignalDays: number; winRate: number; perMWh: number; filled: number; totalTrades: number; totGross: number; fees: number};
  feeSensitivity1PerMWh: {total: number; maxdd: number; filled: number; fees: number};
  days: Array<{date: string; status: string; pnl: number | null; gross: number; filled: number; fees: number}>;
  warnings: string[];
}

export interface ForecastOptimization {
  protocolFrozenAt: string;
  evaluationLabel: string;
  comparisonWindow: DateSplit;
  comparison: {
    v1: ForecastMetrics; v2: ForecastMetrics; baseline: ForecastMetrics;
    maeImprovementVsV1Pct: {da: number; spread: number};
  };
  rollingWindow?: DateSplit & {rows: number};
  blocks: Array<DateSplit & {v2: ForecastMetrics; baseline: ForecastMetrics}>;
  diagnostics: {
    byHour: Array<{hour: string | number; da: ForecastMetric; spread: ForecastMetric}>;
    worstDays: Array<{date: string; daMae?: number; spreadMae?: number; da?: ForecastMetric; spread?: ForecastMetric}>;
  };
  prospective: {status: string; startDate: string; endDate: string; days: number};
  limitations: string[];
}

export interface StrategyOptimizationComparison {
  schemaVersion: number; generatedAt: string; classification: string;
  window: {startDate: string; endDate: string; previouslySeen: boolean};
  selection: string;
  rows: Array<{model: 'v1'|'v2'; modelVersion: string; profileId: string; label: string; strategy: string; k: number; feePerMWh: number;
    netPnl: number | null; maxDrawdown: number | null; filledMWh: number; plannedMWh: number; trades: number; noSignalDays: number; days: number}>;
}

export interface ForecastArchiveReceipt {
  forecastFileDigest: string; batchId: string; platformReceivedAt: string;
  receivedBeforeCutoff: boolean; pointCount: number;
}

export interface ForecastAblation {
  classification: string;
  generatedAt: string;
  requestedAfterMainResults: boolean;
  mainModelChanged: boolean;
  comparisonWindow: DateSplit & {rows: number};
  versions: Record<'v1_56'|'v2_56'|'v2_180', {modelVersion: string; sample: {days: number}}>;
  metrics: Record<'v1_56'|'v2_56'|'v2_180', ForecastMetrics>;
  changes: {
    methodAtFixed56Days: Record<'da'|'spread', {maeChange: number; improvementPct: number}>;
    historyAtFixedV2Method: Record<'da'|'spread', {maeChange: number; improvementPct: number}>;
  };
}
