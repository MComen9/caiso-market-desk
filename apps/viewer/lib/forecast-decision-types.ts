export interface DecisionMetrics {
  netPnl: number | null;
  grossPnl: number | null;
  fees: number | null;
  plannedMWh: number;
  filledMWh: number;
  trades: number;
  noSignalDays: number;
  maxDrawdown: number | null;
  winRate: number | null;
  perMWh: number | null;
  days: number;
}

export interface DecisionGroupMetrics {
  netPnl: number | null;
  filledMWh: number;
  trades: number;
  winRate: number | null;
}

export interface DecisionSummary extends Partial<DecisionMetrics> {
  plannedCells?: number;
  fillRate?: number | null;
  averageWin?: number | null;
  averageLoss?: number | null;
}

export interface DecisionWindow {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  days: number;
  rows: number;
}

export interface DecisionDaily {
  date: string;
  policyId: string;
  grossPnl: number | null;
  plannedMWh: number;
  filledMWh: number;
  trades: number;
  winCountByFee: Record<string, number>;
  netPnlByFee: Record<string, number | null>;
  noSignal: boolean;
}

export interface DecisionReport {
  schemaVersion: number;
  experimentVersion: string;
  generatedAt: string;
  classification: string;
  defaultPolicyId: string;
  defaultWindowId: string;
  defaultFeePerMWh: number;
  feesPerMWh: number[];
  policies: Array<{id: string; label: string; description: string; kind: string}>;
  windows: DecisionWindow[];
  sample: {priceStartDate: string; priceEndDate: string; priceDays: number; priceRows: number; nodes: string[]; fundamentalsRows: number};
  protocol: {frozenAt: string; designDigest: string; design: Record<string, unknown>};
  results: Array<DecisionMetrics & {windowId: string; policyId: string; feePerMWh: number}>;
  monthly: Array<DecisionMetrics & {month: string; startDate: string; endDate: string; policyId: string; feePerMWh: number}>;
  daily: DecisionDaily[];
  diagnostics: {
    v1v2: {
      feePerMWh: number;
      window: {startDate: string; endDate: string; days?: number};
      summary: {v1: DecisionSummary; v2: DecisionSummary};
      byNode: DecisionDiagnosticGroup[];
      byHour: DecisionDiagnosticGroup[];
      byDay: DecisionDiagnosticGroup[];
      bySide: DecisionDiagnosticGroup[];
    };
    inputAttribution: {
      baselinePnl: number;
      allV2Pnl: number;
      delta: number;
      hybrids: Array<{id: string; daVersion: string; spreadVersion: string; sigmaVersion: string; netPnl: number | null; filledMWh?: number; trades?: number}>;
      shapley: Array<{factor: string; contribution: number}>;
      note: string;
    };
  };
  forward: {status: string; reason: string; targetDate: string; existingV2ModelVersion: string; existingV2ForecastDigest: string};
  promotionGate: {status: string; approvedForTrading: boolean; reasons: string[]};
  warnings: string[];
  artifacts?: {bundle?: string; pythonInput?: string; pythonRunner?: string};
}

export interface DecisionDiagnosticGroup {group: string; v1: DecisionGroupMetrics; v2: DecisionGroupMetrics}
