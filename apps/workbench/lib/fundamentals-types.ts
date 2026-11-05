export const FUNDAMENTAL_FEEDS = {
  load_dam: { title: '日前负荷预测', family: 'load', queryname: 'SLD_FCST', market: 'DAM', execution: null, minutes: 60, kind: 'forecast' },
  load_rtpd: { title: '15 分钟负荷预测', family: 'load', queryname: 'SLD_FCST', market: 'RTM', execution: 'RTPD', minutes: 15, kind: 'forecast' },
  load_rtd: { title: '5 分钟负荷预测', family: 'load', queryname: 'SLD_FCST', market: 'RTM', execution: 'RTD', minutes: 5, kind: 'forecast' },
  load_2da: { title: '提前两日负荷预测', family: 'load', queryname: 'SLD_FCST', market: '2DA', execution: null, minutes: 60, kind: 'forecast' },
  load_7da: { title: '提前七日负荷预测', family: 'load', queryname: 'SLD_FCST', market: '7DA', execution: null, minutes: 60, kind: 'forecast' },
  load_actual: { title: '实际小时负荷', family: 'load', queryname: 'SLD_FCST', market: 'ACTUAL', execution: null, minutes: 60, kind: 'actual' },
  renewables_dam: { title: '日前风光预测', family: 'renewables', queryname: 'SLD_REN_FCST', market: 'DAM', execution: null, minutes: 60, kind: 'forecast' },
  renewables_rtpd: { title: '15 分钟风光预测', family: 'renewables', queryname: 'SLD_REN_FCST', market: 'RTPD', execution: null, minutes: 15, kind: 'forecast' },
  renewables_rtd: { title: '5 分钟风光预测', family: 'renewables', queryname: 'SLD_REN_FCST', market: 'RTD', execution: null, minutes: 5, kind: 'forecast' },
  renewables_hasp: { title: 'HASP 小时风光预测', family: 'renewables', queryname: 'SLD_REN_FCST', market: 'HASP', execution: null, minutes: 60, kind: 'forecast' },
  renewables_actual: { title: '实际小时风光出力', family: 'renewables', queryname: 'SLD_REN_FCST', market: 'ACTUAL', execution: null, minutes: 60, kind: 'actual' },
} as const;

export type FundamentalId = keyof typeof FUNDAMENTAL_FEEDS;
export const FUNDAMENTAL_IDS = Object.keys(FUNDAMENTAL_FEEDS) as FundamentalId[];
export const CORE_FUNDAMENTAL_IDS: FundamentalId[] = ['load_dam', 'renewables_dam'];
