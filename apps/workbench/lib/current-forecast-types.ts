import type { ForecastExperiment } from './forecast-lab-types';

/** V4 extends the existing report contract; frozen older experiments keep their schema. */
export interface CurrentForecastExperiment extends ForecastExperiment {
  evaluationLabel?: string;
  executionScope?: Record<string, unknown>;
  artifacts: ForecastExperiment['artifacts'] & {
    forwardCsv?: string;
    package?: string;
    pythonInput?: string;
    runner?: string;
    protocol?: string;
  };
}
