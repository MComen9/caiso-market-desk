# CAISO 当前预测输入与参考数据

生成时间（UTC）：2026-10-30T08:40:03.744Z

V4已使用366天、26,352个节点小时完成训练、开发评估和2026-10-31 PT预测。其余来源保留参考，本轮不使用、不采购，也不阻塞当前预测。

## 当前清单

| 数据 | 本轮状态 | 覆盖 | 模型状态 |
|---|---|---|---|
| 当前价格历史与预测输入 | V4 核心输入 · 已运行 | 2025-10-29—2026-10-29 PT，366天、26,352个完整节点小时。 | 已用于V4训练、开发评估及2026-10-31 PT预测；不改写V1/V2/V3。 |
| 研究枢纽与候选峰谷节点 | 价格映射参考 · 48条冲突保留 | 10/28查询资格列表3,568条；2026-05-02—2026-10-28 PT，64,800条价格对照。7/3 DAM 06–21点有冲突。 | 本轮不使用峰谷申报映射；V4继续使用三个研究枢纽的参考价格。 |
| 完整结算、FRP与真实交易成本 | 规则与费率已取得 | 6份官方结算/费率原件；2026年1月及10月生效费率；FRP节点价尚未取得有效数据。 | V4使用固定 $1/MWh 成交费用情景；以下官方结算材料本轮不入模，保留参考。 |
| 180天官方负荷与风光预测 | 历史值齐全 · 发行版本未齐 | 2026-05-02—10-28 PT，4,320系统小时；DAM/2DA/7DA负荷、六个分区风光及派生净负荷。 | 本轮不使用，保留参考。已取得且独立核验，尚未入模；历史版本未知 |
| 带历史消息时间的风光预测档案 | 源历史消息已取得 · 全版本未知 | EDAM XML：CISO 180天、4,320个目标小时；其中截点前记录1,344条。 | 本轮不使用，保留参考。仅截点前记录可进入进一步时点核验；尚未入模 |
| 天气预测与历史预报批次 | 当前预测与历史批次样本已取得 | NWS三个城市468点位小时；Sacramento指定GFS历史run 72小时。 | 本轮不使用，保留参考。已规范化样本，尚未形成180天加权气象面板或入模 |
| 自己的报价、成交、结算与信用 | 需要参与者授权或文件 | 公开聚合出清可取得；账户级数据尚未提供。 | 本轮不使用，保留参考。未取得，不能用公开总量代替账户记录 |
| 原生电价与拥塞、损耗等分量 | 从现有缓存完整回收 | 180天、3枢纽；DAM 12,960条＋FMM 51,840条，共64,800个原生区间。 | 本轮不使用，保留参考。已整理、尚未入模；FMM没有被压平为小时 |
| 燃料价格、排放价格与燃料区映射 | 180天数据及区域表已取得 | 180天；868,176条燃料区小时索引、180条排放价格索引；184条区域映射。 | 本轮不使用，保留参考。已取得、尚未入模；当前映射没有历史效期 |
| 发电停运与未来停运计划 | 计划和明细样本已取得 | 10/28汇总报告的三个枢纽5,230条计划行；10/29 AM 628行；10/28前日明细2,235区间行。 | 本轮不使用，保留参考。已取得、尚未形成180天按发行时点选择的面板 |
| 输电接口容量、计划与约束 | 公开接口样本已取得 | 10/28日前接口报表36,816行。 | 本轮不使用，保留参考。已取得单日样本，尚未入模或取得完整拓扑 |
| Outlook历史与GridStatus托管 | 已核验当前访问限制 | 本轮线上检查：Outlook demand源返回403；GridStatus configured=false。 | 本轮不使用，保留参考。现有官方OASIS和本轮新增公开数据可独立使用 |
| EIA-930 系统状态参考 | 小时面板已取得 · 本轮不入模 | 2025-10-29—2026-10-29 PT，8,784个时间区间；需求等主要列有效8,706小时，逐列有效数见审计。 | 本轮不使用，保留参考；3个全空列排除，缺失值未补零。 |

## 当前价格历史与预测输入

**作用：** 用完整DAM/FMM小时价格、滞后统计、跨枢纽及日历特征直接预测。

**数据口径与参考限制：** 特征与标签截止D−2；历史重建使用当前取得的价格版本。最终28天仍称开发评估，不作为全新独立测试。

**来源：** https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf

## 研究枢纽与候选峰谷节点

**作用：** 核对参考枢纽与六个ONPEAK/OFFPEAK节点，保留官方日历和实际返回节点两个字段，为后续申报规则改造提供输入。

**数据口径与参考限制：** 六个峰谷ID在资格表中，三个旧参考ID未出现。64,800条价格逐值相等，但7/3 PT 06–21点的DAM有48条日历ON、实际节点OFFPEAK；同小时FMM正常。原因未确认，异常已单列，自动映射未通过。单节点限额返回空，不能解释为无限额。

**来源：** https://www.caiso.com/documents/sibr_scuserguidewebsdk35v71.pdf

## 完整结算、FRP与真实交易成本

**作用：** 核对官方结算规则和费用口径；V4按统一假设比较研究策略，不等待完整结算数据。

**数据口径与参考限制：** V4按每模拟成交MWh扣 $1，输出情景损益；未覆盖的费用不被解释为零，也不称完整账户净收益。CC4515有效非零报价段即使未成交也可能收费。FRP GroupZip返回1015、SingleZip候选参数返回1001；没有以影子价格替代节点价格。SC合同、信用和最终结算需参与者数据。

**来源：** https://www.caiso.com/documents/grid-management-charge-rates-2004-2006-effective-oct-01-2026.pdf；https://www.caiso.com/systems-applications/portals-applications/market-results-interface-settlements-mri-s

## 180天官方负荷与风光预测

**作用：** 形成与180天价格/实际基本面对齐的预测面板，支持预测误差和供需预期分析。

**数据口径与参考限制：** 普通CSV不含逐值实际发行时间；publishTimeUtc保留null。DAM/2DA/7DA是预测期限，不是同一预测的三次发行。不能当作已证明无前视的回测输入。

**来源：** https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf

## 带历史消息时间的风光预测档案

**作用：** 将目标区间、源消息时间、官方发布事件、本次获取时间分开，为按时点选择历史预测提供证据。

**数据口径与参考限制：** 研究截点为D−1 09:55 PT，晚于截点的消息不能用于该次预测。单日样本的XML消息比同报告同目标日发布事件晚145秒；两者均早于截点，但没有publication ID或内容摘要绑定，未证明历史字节或全部发行版本。

**来源：** https://opensource.gridstatus.io/en/latest/_modules/gridstatus/caiso/caiso.html#CAISO.get_edam_wind_solar_forecast

## 天气预测与历史预报批次

**作用：** 温度、湿度、风速、云量和辐射可解释负荷与风光变化，后续需匹配负荷区/电站装机权重。

**数据口径与参考限制：** 三个城市不是枢纽中心，也没有负荷/装机权重。历史run初始化时间不等于公开可用时间；Open-Meteo免费托管限非商业用途，商业接入需相应方案或自建。

**来源：** https://www.weather.gov/documentation/services-web-api；https://open-meteo.com/en/docs/single-runs-api；https://open-meteo.com/en/terms

## 自己的报价、成交、结算与信用

**作用：** 核对真实执行、Forecasted Movement、分摊费用和资金约束，形成真实收益标签。

**数据口径与参考限制：** MRI-S/CMRI需要参与者证书和授权；SC服务费分摊还需合同。当前12/6/2 MWh是研究约束，不是已核验的账户额度。

**来源：** https://www.caiso.com/systems-applications/portals-applications/market-results-interface-settlements-mri-s；https://www.caiso.com/systems-applications/portals-applications/customer-market-results-interface-cmri

## 原生电价与拥塞、损耗等分量

**作用：** 研究拥塞、损耗、能源和排放分量对节点价差的贡献，保留15分钟结构。

**数据口径与参考限制：** 分量属于当前取得的历史修订版本，四分量加总容差为$0.0001/MWh。5分钟RTD仍仅有7日页面预载，未扩展为长历史；RTD不能替代虚拟交易FMM能源结算。拥塞分量也不是物理约束或完整结算成本。

**来源：** https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf

## 燃料价格、排放价格与燃料区映射

**作用：** 构造燃料成本、区域价差与排放成本特征。先按BA=CISO和明确的Pricing Hub筛选，不按名称前缀猜测。

**数据口径与参考限制：** 燃料价格是公开索引，不是机组合同成本。184条映射中57条BA=CISO；FRPGE与FRPGE1属于不同BA，未匹配区域需保留未知。排放索引与LMP的MGHG分量不同。

**来源：** https://www.caiso.com/documents/fuelregion_electricregiondefinitions.xlsx

## 发电停运与未来停运计划

**作用：** 识别可用容量变化、停运类型和持续区间；未来计划与事后实际分别使用。

**数据口径与参考限制：** AM含其他BA和跨区域重复，前日表有未定结束时间。计划包含未来日期，不是未来实际；Aggregate与燃料子项不能重复相加，不能直接累加所有行的MW。

**来源：** https://www.caiso.com/market-operations/outages

## 输电接口容量、计划与约束

**作用：** 区分接口方向、容量、计划和余量，支持进口约束与拥塞场景分析。

**数据口径与参考限制：** TR_TYPE和LABEL含不同指标，不能累加为净进口。详细输电停运和完整网络模型的部分资料需要证书；历史发行、约束到目标节点的影响关系仍缺。

**来源：** https://www.caiso.com/systems-applications/portals-applications/open-access-same-time-information-system-oasis

## Outlook历史与GridStatus托管

**作用：** 补充发电结构、进口、储能等连续历史，或使用托管数据历史发行服务。

**数据口径与参考限制：** Outlook受当前服务器访问限制；GridStatus需Key和对应数据集权限。未绕过限制、未购买套餐、未把两日快照扩写为180天。

**来源：** https://www.caiso.com/todays-outlook；https://www.gridstatus.io/settings/api

## EIA-930 系统状态参考

**作用：** 保留需求、发电结构和净交换的独立研究参考，不作为V4预测依赖。

**数据口径与参考限制：** 电池储能、抽水蓄能与CFE交换全空，不能据此称储能数据已补齐。其余列有不同缺失和报告延迟；8,784是时间区间数，不是每列有效值数。当前下载未证明历史首次发行。

**来源：** https://www.eia.gov/electricity/930-content/about.html

## Python读取

压缩JSON使用标准库gzip即可读取；大多数新增表以fields定义列、rows存二维数组。原生价格分量和weather-evidence使用自描述对象结构。

```python
import gzip, json
with gzip.open("official-forecast-history-180d.json.gz", "rt", encoding="utf-8") as stream:
    data = json.load(stream)
records = [dict(zip(data["fields"], row)) for row in data["rows"]]
print(len(records), records[0])
```

## 采集与复现

本包包含采集、规范化、独立核验代码；不包含密钥。离线可直接读取所有数据。在线重新采集需访问公开CAISO/NWS服务，并遵守限流。

```bash
python research/fetch_missing_data.py --campaign priority
python research/fetch_missing_data.py --campaign seasonal
python research/fetch_missing_data.py --campaign node_history
python research/fetch_missing_data.py --campaign vintage
python research/build_missing_data.py
node research/verify_missing_forecasts.mjs
```

OASIS EDAM GroupZip曾对月范围请求只返回起始日，已改为逐日查询并按目标日期验覆盖。HTTP 200不等于业务数据齐全。当前源文件与历史首次字节的一致性仍无法完整证明。

本包的SHA-256清单覆盖全部成员。原始OASIS证据另见oasis-public-responses.zip；结算原件和天气原件分别在各证据目录的ZIP中。完整应用和冻结模型继续在原平台保留。

## 当前预测入口与交付

[返回当前预测](/#prices/prediction)。本轮模型、输入和模拟产物见 `/data/forecast-lab/v4/`；新增采集与逐文件哈希见 `/data/current-inputs/README.md` 和 `/data/current-inputs/manifest.json`。

本页已按V4实际使用状态更新。此前参考数据ZIP保持原版本，未因本次目录更新重新打包；旧包内部README对应当时采集阶段。
