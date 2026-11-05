#!/usr/bin/env python3
"""Publish a small data-readiness catalog, with separate acquisition/model status."""
from pathlib import Path
import json
from fetch_missing_data import ROOT, atomic_json, stamp

OUT = ROOT / 'public/data/data-gaps'
BASE = '/data/data-gaps/'
CURRENT = ROOT / 'public/data/current-inputs'
FAQ = 'https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf'


def read(name, default=None):
    path = OUT / name
    return json.loads(path.read_text()) if path.exists() else (default or {})


def link(label, name):
    return {'label': label, 'href': BASE + name}


def source(label, url):
    return {'label': label, 'url': url}


def examples(audit):
    rows = audit.get('sampleRows', audit.get('examples', []))
    return [{key: ('是' if value else '否') if isinstance(value, bool) else value for key, value in row.items() if value is None or isinstance(value, (str, int, float))} for row in rows[:3]]


def main():
    current_report_path = ROOT / 'public/data/forecast-lab/v4/report.json'
    current_report = json.loads(current_report_path.read_text()) if current_report_path.exists() else None
    forecast = read('official-forecast-history-180d-audit.json')
    vintage = read('edam-wind-solar-vintages-audit.json')
    native = read('price-components-audit.json')
    annual = read('price-history-365d-audit.json')
    mapping = read('tradable-node-map-180d-audit.json') or read('tradable-node-map-14d-audit.json')
    mapping_id = mapping.get('dataset', 'tradable-node-map-14d')
    weather = {item['id']: item for item in read('weather-evidence/weather-audit.json').get('datasets', [])}
    audit = read('acquisition-audit.json')
    data = {row['dataset']: row for row in audit.get('datasets', [])}
    items = []

    def item(id, title, category, priority, status, label, before, coverage, use, model, limitation, metrics, sources, downloads, samples=()):
        items.append({'id': id, 'title': title, 'category': category, 'priority': priority, 'status': status,
                      'statusLabel': label, 'before': before, 'coverage': coverage, 'useCase': use,
                      'modelStatus': model, 'limitation': limitation,
                      'metrics': [{'label': key, 'value': str(value)} for key, value in metrics],
                      'sources': sources, 'downloads': downloads, 'sampleRows': list(samples)})

    item('node-mapping', '研究枢纽与候选峰谷节点', 'settlement', 'P0', 'partial', '映射已验证 · 限额未齐' if mapping.get('mappingVerified') else f"{mapping.get('peakMappingMismatches', '待查')}条日历冲突 · 未通过",
         '原模型的三个全时段枢纽ID没有与虚拟交易资格列表及峰谷时段建立映射。',
         f"10/28查询资格列表3,568条；{mapping.get('startDate', '待取得')}—{mapping.get('endDate', '待取得')} PT，{mapping.get('rows', 0):,}条价格对照。7/3 DAM 06–21点有冲突。",
         '核对参考枢纽与六个ONPEAK/OFFPEAK节点，保留官方日历和实际返回节点两个字段，为后续申报规则改造提供输入。',
         '已整理，尚未替换V1/V2/V3节点或订单',
         f"六个峰谷ID在资格表中，三个旧参考ID未出现。64,800条价格逐值相等，但7/3 PT 06–21点的DAM有{mapping.get('peakMappingMismatches', '未知')}条日历ON、实际节点OFFPEAK；同小时FMM正常。原因未确认，异常已单列，自动映射未通过。单节点限额返回空，不能解释为无限额。",
         [('对照价格数', mapping.get('rows', 0)), ('峰谷日历不符', mapping.get('peakMappingMismatches', '未知')),
          ('最大价格差 $/MWh', mapping.get('maximumPriceDifference', '未知')), ('节点组约束样本', data.get('cb_group_limits', {}).get('rows', 0))],
         [source('CAISO SIBR用户指南', 'https://www.caiso.com/documents/sibr_scuserguidewebsdk35v71.pdf')],
         [link('节点与价格映射', mapping_id + '.json.gz'), link('48条冲突及独立核验', 'node-mapping-discrepancies.json'), link('资格核对', 'settlement-evidence/node-eligibility-check.json'), link('节点组约束', 'cb_group_limits.json.gz')], examples({'sampleRows': mapping.get('mappingConflictExamples', [])}) or examples(mapping))

    item('settlement-costs', '完整结算、FRP与真实交易成本', 'settlement', 'P0', 'partial', '规则与费率已取得',
         '历史模型仅计能源价差和人工设定的成交MWh费用，缺Forecasted Movement与提交费等。',
         '6份官方结算/费率原件；2026年1月及10月生效费率；FRP节点价尚未取得有效数据。',
         '把能源收益、Virtual Forecasted Movement、提交费、成交服务费、账户固定成本分开计算。',
         '已整理，旧收益结果保持冻结，未改成全成本收益',
         'CC4515有效非零报价段即使未成交也可能收费。FRP GroupZip返回1015、SingleZip候选参数返回1001；没有以影子价格替代节点价格。SC合同、信用和最终结算需参与者数据。',
         [('CC4560 1–9月', '$0.1416/MWh'), ('CC4560 10月起', '$0.1216/MWh'), ('CC4515', '$0.005/有效报价段'), ('CC4575', '$1,500/SCID/月')],
         [source('2026官方费率', 'https://www.caiso.com/documents/grid-management-charge-rates-2004-2006-effective-oct-01-2026.pdf'), source('MRI-S结算文件', 'https://www.caiso.com/systems-applications/portals-applications/market-results-interface-settlements-mri-s')],
         [link('结算证据包', 'settlement-evidence/download-evidence.zip'), link('规则和费率JSON', 'settlement-evidence/settlement-gap-evidence.json')])

    item('official-forecasts', '180天官方负荷与风光预测', 'prediction', 'P0', 'partial', '历史值齐全 · 发行版本未齐',
         '负荷/风光预测接口已接，但训练档案只有10/28、10/29两日快照。',
         '2026-05-02—10-28 PT，4,320系统小时；DAM/2DA/7DA负荷、六个分区风光及派生净负荷。',
         '形成与180天价格/实际基本面对齐的预测面板，支持预测误差和供需预期分析。',
         '已取得且独立核验，尚未入模；历史版本未知',
         '普通CSV不含逐值实际发行时间；publishTimeUtc保留null。DAM/2DA/7DA是预测期限，不是同一预测的三次发行。不能当作已证明无前视的回测输入。',
         [('系统小时', forecast.get('rows', 0)), ('源数值字段', 9), ('派生数值字段', 3), ('缺失值', sum(forecast.get('missingByField', {}).values()))],
         [source('CAISO OASIS官方API说明', FAQ)],
         [link('预测历史面板', 'official-forecast-history-180d.json.gz'), link('独立数值核验', 'forecast-history-verification.json')], examples(forecast))

    item('forecast-vintages', '带历史消息时间的风光预测档案', 'prediction', 'P0', 'partial', '源历史消息已取得 · 全版本未知',
         '原有SLD_REN_FCST快照没有真实源消息时间，无法核对截点。',
         f"EDAM XML：CISO {vintage.get('cisoDays', 0)}天、{vintage.get('distinctCisoHours', vintage.get('cisoRows', 0)):,}个目标小时；其中截点前记录{vintage.get('cisoRowsBeforeCutoff', 0):,}条。",
         '将目标区间、源消息时间、官方发布事件、本次获取时间分开，为按时点选择历史预测提供证据。',
         '仅截点前记录可进入进一步时点核验；尚未入模',
         '研究截点为D−1 09:55 PT，晚于截点的消息不能用于该次预测。单日样本的XML消息比同报告同目标日发布事件晚145秒；两者均早于截点，但没有publication ID或内容摘要绑定，未证明历史字节或全部发行版本。',
         [('目标小时 / 预期', f"{vintage.get('distinctCisoHours', 0)} / {vintage.get('expectedCisoHours', 4320)}"),
          ('截点前消息 / CISO消息', f"{vintage.get('cisoMessageCountBeforeCutoff', 0)} / {vintage.get('cisoMessageCount', 0)}"),
          ('截点前小时记录', vintage.get('cisoRowsBeforeCutoff', 0)), ('发布日志事件', data.get('publication_log', {}).get('rows', 0))],
         [source('GridStatus开源EDAM解析', 'https://opensource.gridstatus.io/en/latest/_modules/gridstatus/caiso/caiso.html#CAISO.get_edam_wind_solar_forecast')],
         [link('带时间风光档案', 'edam-wind-solar-vintages.json.gz'), link('发布日志', 'publication_log.json.gz'), link('单日时间交叉核验', 'edam-vintage-verification.json')], examples(vintage))

    n, w = weather.get('nws-current-weather', {}), weather.get('gfs-historical-single-run', {})
    item('weather', '天气预测与历史预报批次', 'prediction', 'P0', 'partial', '当前预测与历史批次样本已取得',
         '平台此前没有规范化天气数据，也没有可区分模式初始化与发布时刻的历史预报。',
         f"NWS三个城市{n.get('recordCount', 0)}点位小时；Sacramento指定GFS历史run {w.get('recordCount', 0)}小时。",
         '温度、湿度、风速、云量和辐射可解释负荷与风光变化，后续需匹配负荷区/电站装机权重。',
         '已规范化样本，尚未形成180天加权气象面板或入模',
         '三个城市不是枢纽中心，也没有负荷/装机权重。历史run初始化时间不等于公开可用时间；Open-Meteo免费托管限非商业用途，商业接入需相应方案或自建。',
         [('NWS点位', 3), ('NWS点位小时', n.get('recordCount', 0)), ('历史run小时', w.get('recordCount', 0)), ('历史样本空值', 2)],
         [source('NWS开放API', 'https://www.weather.gov/documentation/services-web-api'), source('历史天气批次API', 'https://open-meteo.com/en/docs/single-runs-api'), source('Open-Meteo使用条款', 'https://open-meteo.com/en/terms')],
         [link('天气/停运证据包', 'weather-evidence/weather-outage-evidence.zip'), link('天气数据清单', 'weather-evidence/weather-audit.json')], examples(n))

    item('private-execution', '自己的报价、成交、结算与信用', 'settlement', 'P0', 'blocked', '需要参与者授权或文件',
         '当前只有研究生成的订单，没有自己的正式提交回执、出清回执、结算账单或信用余额。',
         '公开聚合出清可取得；账户级数据尚未提供。',
         '核对真实执行、Forecasted Movement、分摊费用和资金约束，形成真实收益标签。',
         '未取得，不能用公开总量代替账户记录',
         'MRI-S/CMRI需要参与者证书和授权；SC服务费分摊还需合同。当前12/6/2 MWh是研究约束，不是已核验的账户额度。',
         [('公共系统出清样本', data.get('cb_system_awards', {}).get('rows', 0)), ('账户级成交/结算', '未取得')],
         [source('MRI-S', 'https://www.caiso.com/systems-applications/portals-applications/market-results-interface-settlements-mri-s'), source('CMRI', 'https://www.caiso.com/systems-applications/portals-applications/customer-market-results-interface-cmri')],
         [link('公共虚拟交易总量', 'cb_system_awards.json.gz')])

    item('price-components', '原生电价与拥塞、损耗等分量', 'prediction', 'P1', 'ready', '从现有缓存完整回收',
         '模型档案只保存LMP及小时FMM均值；已取到的MCE/MCC/MCL/MGHG尚未整理使用。',
         '180天、3枢纽；DAM 12,960条＋FMM 51,840条，共64,800个原生区间。',
         '研究拥塞、损耗、能源和排放分量对节点价差的贡献，保留15分钟结构。',
         '已整理、尚未入模；FMM没有被压平为小时',
         '分量属于当前取得的历史修订版本，四分量加总容差为$0.0001/MWh。5分钟RTD仍仅有7日页面预载，未扩展为长历史；RTD不能替代虚拟交易FMM能源结算。拥塞分量也不是物理约束或完整结算成本。',
         [('原生区间', '64,800'), ('分量数值', '259,200'), ('缺失区间', 0), ('超加总容差', 0)],
         [source('OASIS价格API说明', FAQ)],
         [link('原生价格分量', 'price-components-180d.json.gz'), link('来源与一致性审计', 'price-components-audit.json')])

    item('seasonal-prices', '完整年度价格与制度变化', 'prediction', 'P1', 'ready' if annual.get('complete') else 'partial', '年度历史已补齐' if annual.get('complete') else '年度覆盖待核验',
         '原价格档案仅180天，缺冬春季，无法检验完整季节变化。',
         f"2025-10-29—2026-10-28 PT，{annual.get('rows', 0):,}个节点小时。",
         '提供跨季节训练与分期验证基础，并单列2026-05-01制度切换。',
         '已补充研究输入，尚未重训或重算旧业绩',
         '新增早期价格可能含修订。DAME前后收益定义及市场机制不同，必须按制度分段验证；一个年度仍不等于多年稳健性证据。',
         [('年度节点小时', annual.get('rows', 0)), ('缺失小时配对', annual.get('missingHourlyPairs', '待验证')), ('节点', 3)],
         [source('OASIS保留期与查询范围', FAQ)],
         [link('365天价格', 'price-history-365d.json.gz'), link('覆盖检查', 'price-history-365d-audit.json')], examples(annual))

    item('fuel-carbon', '燃料价格、排放价格与燃料区映射', 'market', 'P1', 'ready', '180天数据及区域表已取得',
         '缺少气价成本驱动及燃料区到加州价格区域的明确映射。',
         f"180天；{data.get('fuel_prices', {}).get('rows', 0):,}条燃料区小时索引、180条排放价格索引；184条区域映射。",
         '构造燃料成本、区域价差与排放成本特征。先按BA=CISO和明确的Pricing Hub筛选，不按名称前缀猜测。',
         '已取得、尚未入模；当前映射没有历史效期',
         '燃料价格是公开索引，不是机组合同成本。184条映射中57条BA=CISO；FRPGE与FRPGE1属于不同BA，未匹配区域需保留未知。排放索引与LMP的MGHG分量不同。',
         [('燃料区小时行', data.get('fuel_prices', {}).get('rows', 0)), ('排放日索引', 180), ('映射条目', 184), ('CISO燃料区', 57)],
         [source('CAISO燃料区定义表', 'https://www.caiso.com/documents/fuelregion_electricregiondefinitions.xlsx')],
         [link('燃料价格历史', 'fuel_prices.json.gz'), link('排放价格历史', 'ghg_allowance.json.gz'), link('燃料区映射', 'weather-evidence/fuel-region-mapping.json')], examples(data.get('fuel_prices', {})))

    item('outages', '发电停运与未来停运计划', 'market', 'P1', 'partial', '计划和明细样本已取得',
         '当前模型没有发电停运特征，公开快照未形成连续发行档案。',
         '10/28汇总报告的三个枢纽5,230条计划行；10/29 AM 628行；10/28前日明细2,235区间行。',
         '识别可用容量变化、停运类型和持续区间；未来计划与事后实际分别使用。',
         '已取得、尚未形成180天按发行时点选择的面板',
         'AM含其他BA和跨区域重复，前日表有未定结束时间。计划包含未来日期，不是未来实际；Aggregate与燃料子项不能重复相加，不能直接累加所有行的MW。',
         [('枢纽计划行', data.get('generation_outages', {}).get('rows', 0)), ('AM行', 628), ('前日区间行', 2235)],
         [source('CAISO停运信息', 'https://www.caiso.com/market-operations/outages')],
         [link('三枢纽停运计划', 'generation_outages.json.gz'), link('机组明细与原件', 'weather-evidence/weather-outage-evidence.zip')], examples(data.get('generation_outages', {})))

    item('transmission', '输电接口容量、计划与约束', 'market', 'P1', 'partial', '公开接口样本已取得',
         '缺供需之外的网络约束信息；拥塞价格分量不能替代物理约束数据。',
         f"10/28日前接口报表{data.get('transmission_usage', {}).get('rows', 0):,}行。",
         '区分接口方向、容量、计划和余量，支持进口约束与拥塞场景分析。',
         '已取得单日样本，尚未入模或取得完整拓扑',
         'TR_TYPE和LABEL含不同指标，不能累加为净进口。详细输电停运和完整网络模型的部分资料需要证书；历史发行、约束到目标节点的影响关系仍缺。',
         [('接口指标行', data.get('transmission_usage', {}).get('rows', 0)), ('当前历史覆盖', '1日')],
         [source('OASIS公开数据', 'https://www.caiso.com/systems-applications/portals-applications/open-access-same-time-information-system-oasis')],
         [link('输电接口样本', 'transmission_usage.json.gz')], examples(data.get('transmission_usage', {})))

    item('external-access', 'Outlook历史与GridStatus托管', 'market', 'P2', 'blocked', '已核验当前访问限制',
         'Outlook只有两日预载快照；GridStatus有适配器，没有托管历史数据。',
         '本轮线上检查：Outlook demand源返回403；GridStatus configured=false。',
         '补充发电结构、进口、储能等连续历史，或使用托管数据历史发行服务。',
         '现有官方OASIS和本轮新增公开数据可独立使用',
         'Outlook受当前服务器访问限制；GridStatus需Key和对应数据集权限。未绕过限制、未购买套餐、未把两日快照扩写为180天。',
         [('Outlook源响应', '403'), ('GridStatus Key', '未配置'), ('已保留Outlook日期', 2)],
         [source('Today’s Outlook', 'https://www.caiso.com/todays-outlook'), source('GridStatus API Key', 'https://www.gridstatus.io/settings/api')],
         [link('本轮连通检查', 'source-status.json')])

    catalog = {'schemaVersion': 1, 'generatedAt': stamp(), 'headline': '预测数据补齐与剩余缺口',
               'summary': '先核对数据是否取得，再判断能否在决策时点使用。公开数据已补取、规范化并保留来源；本轮没有重训模型或改写V1/V2/V3收益。',
               'items': items,
               'downloads': [link('数据补齐包', 'caiso-data-gap-delivery.zip'), link('原始OASIS响应与回执', 'oasis-public-responses.zip'), link('采集和覆盖审计', 'acquisition-audit.json'), link('说明与运行方法', 'DATA_GAPS_README.md')],
               'warnings': ['获取状态与模型使用状态分别显示；绿色已取得不表示可直接用于无前视回测或实盘。',
                            '费用、账户执行和完整结算仍未齐全。现有历史盈利结果仍是简化研究结果。']}
    if current_report:
        # Retain earlier gap evidence as reference, outside the current run's dependencies.
        sample = current_report['sample']
        price_audit_path = CURRENT / 'current-prices-audit.json'
        current_audit = json.loads(price_audit_path.read_text()) if price_audit_path.exists() else {}
        current_link = lambda label, name: {'label': label, 'href': '/data/current-inputs/' + name}
        for row in items:
            row['priority'] = 'P2'
            row['modelUse'] = 'reference'
            row['modelStatus'] = '本轮不使用，保留参考。' + row['modelStatus']
        prices = next(row for row in items if row['id'] == 'seasonal-prices')
        prices.update(title='当前价格历史与预测输入', priority='P0', status='ready',
                      statusLabel='V4 核心输入 · 已运行', modelUse='current',
                      coverage=f"{sample['startDate']}—{sample['endDate']} PT，{sample['days']}天、{sample['rows']:,}个完整节点小时。",
                      modelStatus=f"已用于V4训练、开发评估及{current_report['forecast']['targetDate']} PT预测；不改写V1/V2/V3。",
                      useCase='用完整DAM/FMM小时价格、滞后统计、跨枢纽及日历特征直接预测。',
                      limitation=f"特征与标签截止D−{current_report['method']['featureDelayDays']}；历史重建使用当前取得的价格版本。最终28天仍称开发评估，不作为全新独立测试。",
                      metrics=[{'label': '完整交易日', 'value': str(sample['days'])}, {'label': '节点小时', 'value': f"{sample['rows']:,}"},
                               {'label': '本轮新增节点小时', 'value': str(current_audit.get('newNodeHours', 0))}, {'label': '预测节点小时', 'value': str(current_report['forecast']['rows'])}],
                      downloads=[current_link('当前价格输入', 'price-history-current.json.gz'), current_link('覆盖与新增价格审计', 'current-prices-audit.json'),
                                 {'label': 'V4 模型评估', 'href': '/data/forecast-lab/v4/report.json'}], sampleRows=[])
        settlement = next(row for row in items if row['id'] == 'settlement-costs')
        settlement['modelStatus'] = 'V4使用固定 $1/MWh 成交费用情景；以下官方结算材料本轮不入模，保留参考。'
        settlement['useCase'] = '核对官方结算规则和费用口径；V4按统一假设比较研究策略，不等待完整结算数据。'
        settlement['limitation'] = 'V4按每模拟成交MWh扣 $1，输出情景损益；未覆盖的费用不被解释为零，也不称完整账户净收益。' + settlement['limitation']
        node_mapping = next(row for row in items if row['id'] == 'node-mapping')
        node_mapping['statusLabel'] = '价格映射参考 · 48条冲突保留'
        node_mapping['modelStatus'] = '本轮不使用峰谷申报映射；V4继续使用三个研究枢纽的参考价格。'
        eia_path = CURRENT / 'eia/eia930-ciso-audit.json'
        if eia_path.exists():
            eia = json.loads(eia_path.read_text())
            valid_demand = eia.get('fieldStats', {}).get('demandMw', {}).get('count', 0)
            excluded = eia.get('excludedAllMissingFields', [])
            item('eia-system-reference', 'EIA-930 系统状态参考', 'market', 'P2', 'partial', '小时面板已取得 · 本轮不入模',
                 '此前没有独立的EIA系统需求、发电和交换历史面板。',
                 f"{eia['startDate']}—{eia['endDate']} PT，{eia['rows']:,}个时间区间；需求等主要列有效{valid_demand:,}小时，逐列有效数见审计。",
                 '保留需求、发电结构和净交换的独立研究参考，不作为V4预测依赖。',
                 '本轮不使用，保留参考；3个全空列排除，缺失值未补零。',
                 '电池储能、抽水蓄能与CFE交换全空，不能据此称储能数据已补齐。其余列有不同缺失和报告延迟；8,784是时间区间数，不是每列有效值数。当前下载未证明历史首次发行。',
                 [('时间区间', eia['rows']), ('需求有效小时', valid_demand), ('全空列排除', len(excluded)), ('V4 使用', '否')],
                 [source('EIA-930 官方说明', 'https://www.eia.gov/electricity/930-content/about.html')],
                 [current_link('EIA 归一小时面板', 'eia/eia930-ciso-current.json.gz'), current_link('逐字段覆盖审计', 'eia/eia930-ciso-audit.json'), current_link('源响应回执', 'eia/receipt.json')])
            items[-1]['modelUse'] = 'reference'
        items.sort(key=lambda row: (row.get('modelUse') != 'current', row['priority']))
        catalog.update(headline='当前预测输入与参考数据',
                       summary=f"V4已使用{sample['days']}天、{sample['rows']:,}个节点小时完成训练、开发评估和{current_report['forecast']['targetDate']} PT预测。其余来源保留参考，本轮不使用、不采购，也不阻塞当前预测。",
                       downloads=[current_link('本轮采集与使用说明', 'README.md'), current_link('新增采集文件清单', 'manifest.json'), current_link('当前价格覆盖审计', 'current-prices-audit.json'),
                                  link('此前参考数据包', 'caiso-data-gap-delivery.zip'), link('此前OASIS原始证据', 'oasis-public-responses.zip'), link('完整数据目录说明', 'DATA_GAPS_README.md')],
                       warnings=['当前预测已运行；数据取得状态与本轮是否入模分别显示。历史缺口仅保留为参考详情，不作为本轮待办。',
                                 'V4模拟按固定 $1/MWh 费用情景评价；未来实际价格与实际收益保持为空。'])
    atomic_json(OUT / 'catalog.json', catalog)
    text = ['# CAISO ' + catalog['headline'], '', '生成时间（UTC）：' + catalog['generatedAt'], '', catalog['summary'], '',
            '## 当前清单', '', '| 数据 | 本轮状态 | 覆盖 | 模型状态 |', '|---|---|---|---|']
    for row in items:
        text.append('| ' + ' | '.join(row[key].replace('|', '/') for key in ['title', 'statusLabel', 'coverage', 'modelStatus']) + ' |')
    for row in items:
        text.extend(['', '## ' + row['title'], '', '**作用：** ' + row['useCase'], '', '**数据口径与参考限制：** ' + row['limitation'], '', '**来源：** ' + '；'.join(x['url'] for x in row['sources'])])
    text.extend(['', '## Python读取', '', '压缩JSON使用标准库gzip即可读取；大多数新增表以fields定义列、rows存二维数组。原生价格分量和weather-evidence使用自描述对象结构。', '',
                 '```python', 'import gzip, json', 'with gzip.open("official-forecast-history-180d.json.gz", "rt", encoding="utf-8") as stream:', '    data = json.load(stream)', 'records = [dict(zip(data["fields"], row)) for row in data["rows"]]', 'print(len(records), records[0])', '```', '',
                 '## 采集与复现', '', '本包包含采集、规范化、独立核验代码；不包含密钥。离线可直接读取所有数据。在线重新采集需访问公开CAISO/NWS服务，并遵守限流。', '',
                 '```bash', 'python research/fetch_missing_data.py --campaign priority', 'python research/fetch_missing_data.py --campaign seasonal', 'python research/fetch_missing_data.py --campaign node_history', 'python research/fetch_missing_data.py --campaign vintage', 'python research/build_missing_data.py', 'node research/verify_missing_forecasts.mjs', '```', '',
                 'OASIS EDAM GroupZip曾对月范围请求只返回起始日，已改为逐日查询并按目标日期验覆盖。HTTP 200不等于业务数据齐全。当前源文件与历史首次字节的一致性仍无法完整证明。', '',
                 '本包的SHA-256清单覆盖全部成员。原始OASIS证据另见oasis-public-responses.zip；结算原件和天气原件分别在各证据目录的ZIP中。完整应用和冻结模型继续在原平台保留。'])
    if current_report:
        text.extend(['', '## 当前预测入口与交付', '', '[返回当前预测](/#prices/prediction)。本轮模型、输入和模拟产物见 `/data/forecast-lab/v4/`；新增采集与逐文件哈希见 `/data/current-inputs/README.md` 和 `/data/current-inputs/manifest.json`。', '',
                     '本页已按V4实际使用状态更新。此前参考数据ZIP保持原版本，未因本次目录更新重新打包；旧包内部README对应当时采集阶段。'])
    (OUT / 'DATA_GAPS_README.md').write_text('\n'.join(text) + '\n')
    (ROOT / 'research/DATA_GAPS.md').write_text('\n'.join(text) + '\n')
    print(json.dumps({'items': len(items), 'statuses': {key: sum(row['status'] == key for row in items) for key in ['ready', 'partial', 'blocked']}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
