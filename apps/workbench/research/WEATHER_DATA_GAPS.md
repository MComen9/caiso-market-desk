# 天气与发电停运数据：本轮找到、取得和仍然缺失的内容

## 交付结论

本轮已实际取得 NOAA/NWS 三个城市点的当前逐小时天气预测、一个指定历史 GFS 运行批次，以及 CAISO 两份公开发电停运原表。它们证明数据来源可访问，并补上可审查的样本；没有完成 180 天全量天气回填，也没有把新增样本并入 V3 重训。

| 数据集 | 已取得范围 | 可用于什么 | 仍然缺什么 |
|---|---|---|---|
| NWS 当前天气预测 | Sacramento、Fresno、Los Angeles 各156小时，共468点位小时 | 当前气温、湿度、风与降水风险参考；从现在开始归档事前输入 | 过去180天每个决策截点实际可见的预报、负荷/装机空间权重 |
| Open-Meteo GFS 历史单次运行 | Sacramento，2026-10-14 00:00 UTC 初始化，72小时，提前0–71小时 | 验证能按指定历史运行批次取得温度、湿度、风速、云量及辐射 | 多日/多点连续覆盖；真实首次可用时间；商用托管授权或自建服务 |
| CAISO AM 发电停运快照 | 2026-10-29，628行、587个资源；其中535行为CISO | 检查当时报告的停运资源、类型、容量和分区 | 资源跨分区重复的去重规则；历史发布版证据；完整连续历史 |
| CAISO 前一交易日停运明细 | 2026-10-28，2235区间行、614个停运MRID、551个资源 | 事后停运归因和事件检查 | 重叠事件/区间的容量聚合规则；当时事前已知的计划版本 |
| CAISO 燃料区映射 | 当前公开表184个燃料区，其中57个标注BA=CISO | 将OASIS天然气价格的区域ID对应到定价枢纽与平衡区 | 历史生效起止日期；新版气价中未出现在当前映射表的区域 |

本页数字来自所附原始响应及离线逐值核验。`public/data/data-gaps/weather-evidence/weather-audit.json` 提供前端可读目录，`weather-outage-evidence.zip` 包含完整原始文件、标准化JSON、获取收据、脚本和校验清单。

## 天气输入的时间含义

NWS 响应提供源更新时间、响应生成时间及预测区间；本地另记实际获取时间。三者分别保存。当前逐小时快照可能包含正在进行或刚结束的区间，进入前向模型前仍需检查有效时间。城市点位只是天气特征采样点，并未被宣称为 CAISO 枢纽中心，也未添加未经验证的负荷或装机权重。

Open-Meteo 单次运行接口按 `run=2026-10-14T00:00` 请求，源响应本身没有独立返回 run 字段。因此标准化文件中的初始化时间来自已保存的请求参数。`sourceAvailabilityUtc` 保持 null。官方说明初始化与对外可用时间不同，全球模式通常还需要数小时计算与分发；不能把初始化时间当成实际发布时间。本次保留 lead0 的云量和辐射两个缺失值，其余358个数值完整。风速原单位为 km/h，辐射为 W/m²；辐射接口变量表示前一小时平均，不能任意改为时点值。

Historical Weather API 的再分析、Historical Forecast API 的连续拼接序列、Previous Runs 的固定提前期、Single Runs 的单一批次是不同产品。本轮取得的是 Single Runs 样本，不能用事后再分析替代历史事前天气预测。历史批次今天可下载，也不等于我们在当时已取得过该批次。

NWS 官方文档允许免费用于任何用途，目前请求需识别应用的 User-Agent。Open-Meteo 免费托管 API 仅适用于非商业用途；本轮只做一个非商业来源验证样本。商用交易平台需要对应商业方案或自建数据服务，本轮没有配置商业 Key，也没有承诺免费托管商用可用。

## 停运数据不可直接求和

AM 原表含 CISO、BANC、LADWP、TIDC、IID，并且37个资源ID出现多行。例如同一机组可能出现在不同 Zone Name 下，直接求和会重复计数。前一交易日报表含多个停运卡、区间断点及重叠事件，469行结束时间为空。本轮保留原记录、源行号和空值，不把空结束时间填为午夜，不输出未经处理的“总停运MW”。

AM 文件打印的生成时间为 `10/29/2026 07:30:02 (PPT)`，官网日程预计约08:30 PT发布。生成时间与网页发布时间不同，均不能直接当作可验证的首次对外可用时间。前一交易日报表是事后记录，不可作为该交易日申报前已知输入。原表本地时间暂保留原字符串；进入UTC事件模型时需单独处理时区和夏令时。

公开发电停运报告只覆盖 CAISO 有信息的资源。详细输电停运报告由官网标明需要有效用户证书，分为未来7天的小时更新短期报告与未来1000天的日更新长期报告。公开发电汇总不替代线路级保密明细。

## 燃料区映射的连接规则

`fuel-region-mapping.json` 来自官方工作簿 `GPI_Fuel_Region` 页。57条 CISO 记录中，13条关联 `PG&E Citygate`，37条关联 `SoCal Citygate`，其余关联其他枢纽或为空。`FRPGE` 的 Balancing Authority 为 `PGE`，而 `FRPGE1` 为 `CISO` / `PG&E Citygate`，不能按ID前缀猜加州范围。

连接天然气价格时，仅去除 Fuel Region 外围空格，并保留原始文本；未匹配ID保持未映射。运输费用、燃料补偿和杂费是描述文本，并非可直接数值相加的费用；Cap & Trade Credit 的 Y/N 也不是碳价。原表不含历史生效起止，当前映射不能证明整个180日历史中始终有效。

## 复现与验证

从项目根目录运行，每次给新输出目录，避免覆盖已经归档的快照：

```bash
python research/fetch_weather_nws.py --output-dir /tmp/caiso-weather-new
python research/fetch_weather_single_run.py --output-dir /tmp/caiso-weather-new
python research/fetch_generator_outage_samples.py --output-dir /tmp/caiso-weather-new
python research/normalize_generator_outage_samples.py --output-dir /tmp/caiso-weather-new
python research/fetch_fuel_region_mapping.py --output-dir /tmp/caiso-weather-new
```

天气请求脚本只需 Python 标准库；XLSX 只读提取需要 openpyxl。历史单次运行和停运脚本固定为本次检验日期，NWS 则获取运行时的当前预测。重新下载的官方文件可能发生修订，因此不能要求新下载字节永远与本次收据一致。

已有交付数据的离线核验：

```bash
python research/verify_weather_evidence.py
```

ZIP解压后在目录中运行：

```bash
python verify_weather_evidence.py --data-dir .
```

核验包括10份原始响应的字节数和SHA-256、468个NWS点位小时逐值一致、UTC区间连续及夏令时跨日不重复、历史run提前期/单位/缺失值一致，以及全部2863条停运标准化记录和184条燃料映射与提取原行的一致性。它证明交付完整和解析一致，不能证明预测效果或历史可用性。

## 来源

- [NWS API 官方文档](https://www.weather.gov/documentation/services-web-api)：费用、User-Agent和逐小时预测入口。
- [Open-Meteo Single Runs](https://open-meteo.com/en/docs/single-runs-api)：指定运行批次、档案范围、初始化与对外可用时间的区别。
- [Open-Meteo 历史预测类型](https://open-meteo.com/en/docs/historical-forecast-api)：拼接预测、固定提前期与单次运行的差别。
- [Open-Meteo 使用条款](https://open-meteo.com/en/terms)：免费托管仅限非商业用途。
- [CAISO 发电停运报告](https://www.caiso.com/market-operations/outages/curtailed-and-non-operational-generators)：AM及前一交易日报表、区域和发布时间口径。
- [CAISO 停运说明及字段释义](https://www.caiso.com/market-operations/outages)：重复事件、容量含义、输电报告证书要求。
- [NOAA/NCEI GFS 历史入口](https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast)：长期低分辨率预报档案另有官方路线，本轮未下载，不计入已补齐数据。
- [CAISO 燃料与电力区域定义](https://www.caiso.com/documents/fuelregion_electricregiondefinitions.xlsx)：燃料区ID、定价枢纽、平衡区和费用描述映射。
