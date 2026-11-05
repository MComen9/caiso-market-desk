# 工作台历史交付记录（保留原版本事实）

> 本文件记录最初各次产品迭代，其中旧标题 v4/v5/v6 是当时的平台版本，不等同于当前预测 V4。当前状态以本目录上层 README.md、仓库交接文档和冻结数据中的 report.json 为准。下面历史评估不能冒充新独立检验。

# CAISO 市场研究台 · v4

面向 CAISO 市场研究的交互式工作台。服务端直接读取官方公开数据，前端提供图表、明细、数据来源与导出。当前实现 **27 组官方数据接口：3 组价格 + 13 组 Today’s Outlook + 11 组 OASIS 负荷与风光数据**。接口组数不表示每个日期都已发布全部数据。

另有 GridStatus 托管 API 适配器；本版尚未配置 `GRIDSTATUS_API_KEY`，不能描述为已经连接或已取得托管数据。

v4 新增实际执行过的 **电价预测实验室**：9 组候选配置、逐日滚动拟合、验证选型、独立残差校准、14 日留出检验、下一交付日的 72 条预测及 Python 策略输入。预测和模拟已贯通，但本轮模型在留出集没有战胜基准，固定策略模拟也为负；页面明确显示“研究版，未通过推广门槛”。

## 当前连通核验（2026-10-29）

生产环境的 3 组价格和 11 组 OASIS 基本面已逐项查询成功，均返回真实数据。Today’s Outlook 采集、解析与真实快照已经验证，但当前生产网络读取公开文件返回 HTTP 403；页面保留快照及原获取时间，明确显示刷新失败，不将其标为在线更新成功。未尝试通过改代理、模拟浏览器身份或降级协议绕过来源限制。GridStatus 仍待正式 API Key 与数据权限。

首页只服务轻量入口，浏览器从站点静态资源并行载入三份已验证数据后挂载工作台，避免将大体积历史记录嵌入服务器首屏。

## 1. 功能架构

| 入口 | 用户任务 | 已实现功能 |
|---|---|---|
| 市场总览 | 先看系统状态和价格背景 | 负荷、净负荷、风光、独立电池、备用、运行状态；负荷预测偏差；三枢纽最近完整日价格概览 |
| 价格分析 | 分析节点价格、训练预测、研究策略 | 价格走势、小时价差、原始明细；电价预测包含模型比较、逐小时曲线与区间、Python 下载、一键模拟；策略实验室包含单日模拟、双方案比较、历史回测、预测版本与重放 |
| 供需与预测 | 按问题查看基本面 | 需求与净负荷、供给与储能、官方预测、容量与排放四个子视图；区域和系列选择、图表与数据表 |
| 数据中心 | 检查可用性和来源 | 27 组目录、搜索与来源筛选、逐组更新、日期/获取时间/口径说明、原始来源、完整数据导出、GridStatus 状态 |

总览、供需和数据中心共用 PT 日期及显示时区；价格分析保留自己的 1–7 日日期范围，以该入口内查询条件为准。总览价格卡片明确显示其最近完整日快照日期。

“更新当前视图”按任务读取对应数据；官方预测按所选数据集逐项加载，数据中心只更新当前检查项。初次选择未预载日期时会读取该日 Outlook。页面没有持续轮询或离线定时任务。更新失败时显示错误并保留同日期已有结果及原获取时间，不用其他日期快照替代；预载日期可恢复快照。时区可选 PT、北京时间、UTC，切换只改变显示，不改变交易日。

## 2. 数据目录

### 价格：3 组

| 市场 | 报表 / 版本 | market_run_id | CSV 数值列 | 原生粒度 |
|---|---|---|---|---|
| DAM | PRC_LMP / 12 | DAM | MW | 60 分钟 |
| FMM | PRC_RTPD_LMP / 3 | RTPD | PRC | 15 分钟 |
| RTD | PRC_INTVL_LMP / 3 | RTM | VALUE | 5 分钟 |

价格单位均为 USD/MWh，保留 LMP 与 MCE/MCC/MCL/MGHG 组成。默认完整节点为 `TH_NP15_GEN-APND`、`TH_SP15_GEN-APND`、`TH_ZP26_GEN-APND`。数据中心价格条目默认展示 NP15，其他节点在价格分析查看。可查询价格不代表节点具备虚拟交易资格。

### Today’s Outlook：13 组

| Feed ID | 内容 |
|---|---|
| `demand` | 实际负荷、日前/小时前预测、需求响应 |
| `netdemand` | 净负荷、需求及预测 |
| `fuelsource` | 各类电源与进口功率 |
| `storage` | 总电池、独立电池、混合资源电池 |
| `hybrids` | 混合资源出力分项 |
| `wind_solar_wo_hybrids` | 不含混合资源的风光出力 |
| `co2` | 分资源碳排放估计速率 |
| `rtm_forecast` | 当日 RA 容量、需求及备用 |
| `rtm_forecast_7day` | 当天及未来 7 天资源充裕度展望 |
| `stats` | 当前状态、备用、峰值等摘要 |
| `peak_and_daily` | 可再生能源与负荷日统计 |
| `peak_and_daily_hybrids` | 混合资源峰值及日电量 |
| `peak_and_daily_storage` | 储能峰值及日电量 |

来源限定为 `https://www.caiso.com/outlook/current/{feed}.csv` 与 `/outlook/history/{YYYYMMDD}/{feed}.csv`；`stats` 使用当前 `stats.txt`，内容为 JSON。历史日不返回当前状态冒充历史状态，尚未发布的日报明确显示不可用。

### OASIS 基本面：11 组

| Feed ID | 内容 | 报表 / market_run_id / execution_type | 分钟 |
|---|---|---|---:|
| `load_dam` | 日前负荷预测 | SLD_FCST v1 / DAM | 60 |
| `load_rtpd` | 15 分钟负荷预测 | SLD_FCST v1 / RTM / RTPD | 15 |
| `load_rtd` | 5 分钟负荷预测 | SLD_FCST v1 / RTM / RTD | 5 |
| `load_2da` | 提前两日负荷预测 | SLD_FCST v1 / 2DA | 60 |
| `load_7da` | 提前七日负荷预测 | SLD_FCST v1 / 7DA | 60 |
| `load_actual` | 实际小时负荷 | SLD_FCST v1 / ACTUAL | 60 |
| `renewables_dam` | 日前风光预测 | SLD_REN_FCST v1 / DAM | 60 |
| `renewables_rtpd` | 15 分钟风光预测 | SLD_REN_FCST v1 / RTPD | 15 |
| `renewables_rtd` | 5 分钟风光预测 | SLD_REN_FCST v1 / RTD | 5 |
| `renewables_hasp` | HASP 小时风光预测 | SLD_REN_FCST v1 / HASP | 60 |
| `renewables_actual` | 实际小时风光出力 | SLD_REN_FCST v1 / ACTUAL | 60 |

价格与基本面均通过 `https://oasis.caiso.com/oasisapi/SingleZip` 获取 ZIP/CSV。

## 3. 服务端 API

```text
GET /api/prices?market=FMM&start=2026-10-28&end=2026-10-28&nodes=TH_NP15_GEN-APND
GET /api/outlook?date=2026-10-28
GET /api/outlook?date=2026-10-28&feed=storage
GET /api/fundamentals?date=2026-10-28&feed=load_dam
GET /api/fundamentals?date=2026-10-28&feed=renewables_dam,renewables_actual
```

- 价格 `start/end` 为 America/Los_Angeles 自然日，包含结束当天；最多连续 7 天、6 个节点。日期默认 PT 昨天，节点默认三个枢纽。
- Outlook `date` 默认 PT 今天；不传 `feed` 查询全部 13 组，传 ID 则查询单组。未来预测从当前发布日的七日 RA 展望读取，不把未来日期当作已有归档日。
- OASIS 基本面为单个 PT 日期；`feed` 最多 3 个逗号分隔 ID，不传时查询 `load_dam,renewables_dam`。
- 价格契约见 `lib/types.ts`；基本面共享 `lib/data-types.ts` 的 `DataBundle/DataFeed`。各组保留 `status/sourceUrl/fetchedAt/requestedDate/dataDate/columns/rows/notes/warnings/error/cached`；日统计使用 `table`，状态摘要使用 `stats`。
- `columns` 保留单位、实际/预测类别、原生粒度、区域和资源；时序行保留 UTC 区间、原始时间标签及可选质量标记。
- 状态区分 `ok/partial/error/unavailable/not_configured`。必须检查业务状态：OASIS 可在 HTTP 200 的 ZIP/XML 中返回 `NO_DATA`。

### GridStatus 服务端适配器

```text
GET /api/gridstatus?resource=status
GET /api/gridstatus?resource=datasets
GET /api/gridstatus?resource=data&dataset=caiso_load&start=2026-10-28&end=2026-10-28&limit=100
GET /api/gridstatus?resource=usage
```

服务端配置 `GRIDSTATUS_API_KEY` 后才能验证授权目录和读取托管数据。Key 仅通过请求头发送，不进入前端、表单、仓库或快照。`status` 只检查配置，不消耗数据查询额度；验证与数据读取由用户主动触发。当前未配置 Key、未用真实账号验证，也未注册或购买套餐。

查询限 CAISO 数据集、1–7 个 PT 日期、最多 1,000 行；页面单次读取最多 100 行。达到上限或仍有下一页时标记 `limited:true`，不能当作完整结果。免费范围、历史权限与对外再发布条件以账号授权为准。公开 CAISO 接入不依赖 GridStatus；开源 `gridstatus` 与托管 `gridstatusio` 也不是同一接入方式。

## 4. 数据口径与异常边界

- UTC 区间作为唯一键；价格日按实际时区处理 23/25 小时。FMM 小时均价要求 4 个完整 15 分钟时段，RTD 要求 12 个完整 5 分钟时段。
- 小时价差 = 同节点同小时 FMM 均价 − DA；均值只统计完整配对小时，不代表净收益。
- 缺失不补零，重复冲突置空，真实零值/负值保留；曲线不跨缺失补线。
- Outlook 需求/净需求不含可调度抽水及电池充电；OASIS 实际小时负荷包含储能充电。跨源比较须先核对口径。日前预测原生小时粒度不会因 5 分钟展示而提高精度。
- 负荷默认系统序列为 `CA ISO-TAC`，不能把其他 TAC/BAA 与系统总量相加。CAISO 风光汇总只取 NP15/SP15/ZP26 同资源、同区间的三个完整值；外部 WEIM/EDAM 区域不纳入，任一缺失则汇总为空。
- 电池功率不是 SOC，总量可能含混合资源及风光成分，不能强行平衡分项。MW、MWh 与 tCO₂/h 分别保留；负日电量表示净充电。
- RA 容量不是可随时调用的保证容量，未来预测不是已发生实际值。碳排放为运行估计。
- 原报表未给实际发布时间时 `publishTimeUtc` 保留为空，不用下载时间或推算日程代替，不宣称能恢复历史预测发布批次。
- Outlook 时分结合文件日期及 PT 解析，处理午夜尾行和当前文件日期滞后；夏令时重复小时无法判断先后时保留原标签，UTC 留空并标记 `ambiguous`。七日 RA 快照跨越 2026-11-01，每份有 12 个重复小时标签保留歧义。
- 尚未发生、尚未发布、无历史接口、空报表、网络错误分别显示。后续官方修订可能改变同条件查询结果，来源和获取时间保留用于追溯。

## 5. 真实快照与更新机制

| 数据 | 快照日期 | 已保存内容 |
|---|---|---|
| 价格走势快照 | 2026-10-22—2026-10-28 PT | 504 DA + 2,016 FMM + 6,048 RTD，共 8,568 条规范化区间 |
| 策略研究历史 | 2026-09-03—2026-10-28 PT | 56 天、3 枢纽、4,032 个完整节点小时；来自 4,032 DA + 16,128 FMM 原生区间，16 组原始查询 URL 留档 |
| Outlook | 2026-10-28、2026-10-29 PT | 每日 13 组状态；历史状态摘要不可用，当日三类日报未发布 |
| OASIS 基本面 | 2026-10-28、2026-10-29 PT | 22 份真实 HTTP 200 报表，1,141 个宽表时段、1,678 个 CAISO 主序列数值；前一日完整，当日实时/实际仅为已发布部分 |

预载数据位于 `data/bootstrap.json`、`data/outlook-bootstrap.json`、`data/fundamentals-bootstrap.json`。原始证据保留在 `data/outlook-raw.json`、`data/fundamentals-raw/`，含来源、时间及原始内容或哈希。

可下载文件包括 `public/data/oasis_prices_2026-10-22_2026-10-28.csv`、`provenance.json`、`outlook_snapshot_2026-10-28_2026-10-29.json`、`outlook_provenance.json`、`outlook_raw/`、`fundamentals-snapshot.json`、`fundamentals-caiso.csv`、`fundamentals-provenance.json`。

内置快照可立即查看，在线按钮读取官方接口。行情页面会话和服务端内存缓存不构成永久历史数据库；内置快照不会自行滚动到新一天。策略实验室通过 D1 永久保留用户主动获取的价格版本、导入的预测批次及运行记录。内置研究历史见 `data/strategy-history.json`；重新抓取并替换内置快照仍需正常构建发布。

## 6. 运行限制

- 上游限定官方 HTTPS 目标和白名单参数，不接受任意 URL。
- 价格与基本面共用 `enqueueOasisTask/waitForOasisSlot`：同一 Worker isolate 内串行，请求起始间隔至少 8 秒，单次超时 25 秒，429 有限重试；缓存 5 分钟并限制规模。
- 8 秒为应用保守配置，不是官方固定限流政策。该队列和缓存不跨全球 Worker 实例共享。
- Outlook 同时最多 3 个请求、20 秒超时；当天缓存 3 分钟，历史缓存 1 小时；逐组失败隔离。
- GridStatus 20 秒超时、5 分钟短期缓存；前端不自动消耗托管查询额度。
- 上游响应及 ZIP 解压有体积限制，结构异常停止解析。Cloudflare Workers 使用 `redirect: 'manual'`，不跟随重定向，非成功 HTTP 状态进入错误处理。
- API 返回 `Cache-Control: private, no-store`。站点访问范围沿用已有 Sites 配置，不在代码中保存访问凭据。

## 7. 代码与验证

界面入口为 `components/market-workspace.tsx`，基础图表与面板为 `series-chart.tsx`、`fundamental-panels.tsx`；原 `oasis-dashboard.tsx` 嵌入价格入口。后端分别位于 `lib/oasis.ts`、`outlook.ts`、`fundamentals.ts`、`gridstatus.ts`，共用 `lib/data-types.ts`；价格时区及聚合见 `lib/time.ts`、`analytics.ts`。

```sh
node scripts/test-oasis.mjs
node scripts/test-analytics.mjs
node scripts/test-outlook.mjs
node scripts/test-fundamentals.mjs
node scripts/test-gridstatus.mjs
node scripts/test-strategy-engine.mjs
node scripts/test-strategy-adversarial.mjs
node scripts/test-strategy-api.mjs
node node_modules/typescript/bin/tsc --noEmit
```

验证覆盖真实样本、ZIP/XML、字段口径、区域范围、负值/零值/空值、重复冲突、时段完整性、DST、MW/MWh、参数白名单和凭据状态。GridStatus 测试使用受控响应，不代表真实账号验证。

`test-fundamentals.mjs --live` 可额外执行真实 OASIS 查询，需要运行环境网络可用。`fetch-fundamentals-snapshot.py` 下载 ZIP 并用相同 TypeScript 解析器生成快照；`fetch-outlook-snapshot.py` 获取原始数据，`test-outlook.mjs --write-snapshot` 验证后生成 Outlook 快照。`import-snapshot.py` 转换已核验价格快照，不联网。

依赖、预览、构建及发布沿用 Sites/Vinext 流程。快照验证、类型检查、构建、浏览器交互和生产接口验证分别记录；本文不单独声明某次部署或所有线上请求已成功。

## 8. 策略实验室：两阶段功能

入口为 **价格分析 → 策略实验室**，沿用四个一级导航。实验室内部按单日模拟、历史回测、数据与版本、运行记录划分任务。首次进入才挂载；切换子页保留当前表单与结果。修改表单后，旧结果标记为配置未重新运行，不混用新参数和旧损益。

一期提供七类策略、手选/滚动筛选节点、信号门槛、报价偏移、每日及节点/小时电量上限、最小数量、费用假设、双方案比较、逐小时明细、CSV 与完整 JSON 证据包。二期提供逐日回测、按时间选择预测版本、平台接收时间校验、滚动节点统计、价格/预测留档、不可变运行记录和冻结输入重放。

默认提供 2026-10-01 至 2026-10-28 的 28 日研究方案，使用此前真实历史数据训练。每次评估最多 31 日；训练数据可覆盖更早时间；每个方案最多 6 个节点；可选择最多 24 个价格档案。扩充实际价格时前端按最多 7 日分段调用 OASIS 的 DA/FMM，成功分段立即保存，停止后不丢弃已保存数据。

### 三类输入与两种时间口径

| 输入 | 计算方式 | 时间边界 |
|---|---|---|
| 历史重建基线 | 同节点同 PT 小时的历史 DA 和 FMM−DA 均值；sigma 为价差样本标准差 | 默认回看28天、至少3个不同历史日、仅用 D−2 及之前且在截点前结束的数据；生成时间是真实运行时间，不倒填为历史发布时间 |
| 外部电价预测 | 用户提供的 CSV/JSON，逐时选择截点前最新版本 | 声明重放检查 `issuedAt`；归档重放还检查平台 `createdAt`，现在导入的旧预测不能冒充过去已有记录 |
| 手工情景 | 手工给定 DA、价差及波动值 | 只用于单日条件试算，禁止当成历史时点回测 |

CSV 必填字段为 `node,startUtc,predictedDa,predictedSpread,sigma,issuedAt,modelVersion`；sigma 可留空，但正 k 门槛会排除缺失/零波动信号。模型版本可以使用导入面板提供的默认值。`startUtc`、`issuedAt` 必须明确含 Z 或 UTC 偏移；重复的节点/目标小时/发布时间拒绝导入。支持 JSON 数组或 `{ "points": [...] }`。可选 `trainingEndUtc` 不得晚于声明发布时间，`sampleCount` 需为正整数。每次文件最多5MB、20,000条；模板按当前节点及交易日生成，保留DST小时差异。

### 计算约束与指标

- 先根据预测、过去数据及参数生成计划，再用实际价格评估；目标日实际价格缺失或修改不会改变原计划。
- 默认研究截点为 D−1 09:55 PT（常规 DAM 关闭10:00 PT），按决策日的真实时区转换。23/25小时日期按UTC唯一时段保留；秋季两个同名历史小时先按历史日期聚合，不冒充两个独立样本。
- 正价差信号对应DEC，负价差对应INC；高门槛策略用 `max(k,1.5)`；半仓减每日预算；固定INC/DEC和逆向仍应用不利价差上限。积极报价使用可配置固定买卖价，不保证成交。
- 先按信号强度排序，满足最小1MWh的候选进入，再在预算/节点/单格限制内按权重分配；这是启发式约束分配，不宣称数学最优。每小时1MWh对应1MW，允许非整数数量；未分配量及排除原因保留。
- 滚动节点选择使用此前可用预测的1MWh模拟成交信号，逐日算胜率和扣费EV；不足门槛不补选。该样本支持度不代表市场流动性。
- DEC模拟能量价差=`Q×(FMM−DA)`，INC=`Q×(DA−FMM)`，再扣设定费用。报价交叉假设全量模拟成交；默认等价时段不成交。缺失DA或所需FMM不得计算收益；不会补零。
- 完整日才进入主累计值、胜率、单位损益、盈利因子和美元最大回撤；不完整日留空并保留已知部分小计。无信号是明确的零计划；缺少预测不能冒充零收益。未计算不当的252日年化美元PnL Sharpe。
- 条件预期值假定全部计划量成交且未扣费用，不是包含成交概率的期望值。所选历史价格可能已修订，因此重建回测不能证明当时首次发布值，也不代表稳定收益。
- 只覆盖价差部分，不包含当前规则的 virtual Forecasted Movement、其他分摊、信用/节点资格/官方报价限制或真实成交回执；不是正式结算或申报工具。

### 研究 API 与持久记录

```text
GET  /api/strategy?resource=catalog
GET  /api/strategy?resource=price&id=<archive_id>
GET  /api/strategy?resource=forecast&id=<batch_id>
GET  /api/strategy?resource=run&id=<run_id>
POST /api/strategy  {"action":"fetch_prices","startDate":"2026-10-28","endDate":"2026-10-28","nodes":["TH_NP15_GEN-APND"]}
POST /api/strategy  {"action":"import_forecast","name":"...","source":"...","modelVersion":"...","text":"CSV or JSON"}
POST /api/strategy  {"action":"run","request":{...StrategyRequest}}
POST /api/strategy  {"action":"replay","id":"<run_id>"}
```

数据合同在 `lib/strategy-types.ts`。`run` 由服务端读取已保存价格和预测，客户端不能用提交的实际价格替换档案。多版本重叠时，采用所选版本中获取时间最新的节点小时，并明确记录合并口径。每次运行固化完整实际价格、预测、参数、引擎版本、来源URL、获取时间和SHA-256；JSON导出包括 `evidence.input` 与结果指纹。重放使用冻结输入，比较结果校验值，不重新抓取行情或悄悄更新预测。

D1绑定为 `DB`，表为 `research_records` 和 `research_record_parts`；不可变记录分块原子写入，UTF-16代理对边界保持完整。目录按价格、预测、运行各显示最近100份，避免新运行挤掉输入版本；旧记录仍可通过ID读取。站点继续沿用owner-private访问边界，研究记录共享于该受限研究台；不是公开写入接口。浏览器写操作还校验同源。没有自动轮询、定时训练、收费预测订阅或实际下单。

新增验证：真实价格基线独立均值/方差核对；20组对抗性检查；SQLite支持的D1存储/API测试含跨域写拒绝、导入失败无脏记录、同输入重放、重复价格去重、多块Unicode一致及禁止改写已有记录。合成测试数据不作为市场业绩。

## 9. v4 电价预测与 Python 输入

入口为 **价格分析 → 电价预测**，直接视图锚点 `#prices/prediction`。三个子视图为逐小时预测、模型与验证、Python 输入与复现。首屏仍保持轻量；模型报告、前向预测、模拟摘要仅在首次进入该视图时读取。

### 真实训练与选型

输入为 `data/strategy-history.json`：2026-09-03 至 10-28 的 56 日、三个枢纽、4,032 个完整配对小时。前七日提供滞后特征，最终监督训练使用 3,528 行。两目标分别是 DA 和四个完整 FMM 的小时均价减 DA。64 个特征包括节点、PT 小时、星期、价格及价差的 2/3/7/14 日滞后、7/14/28 日同小时滚动统计、D−2 日内汇总和跨枢纽滞后。

9 个候选配置包括零价差、上周同小时、7/14/28 日同小时均值、Ridge α=10/100、限制复杂度的 HistGradientBoosting 和 ExtraTrees。全部运行 42 个日度起点、两个目标；每次只使用 D−2 及以前的完整实际日。缺失填补和标准化仅在各次训练窗口拟合。

| 阶段 | 日期 PT | 用途 |
|---|---|---|
| 验证选型 | 2026-09-25–10-06 | 各目标按 MAE 选择；距最优 1% 内按预定顺序偏好简单模型 |
| 间隔 | 10-07 | 不参与模型选择或误差校准 |
| 误差校准 | 10-08–10-13 | 每枢纽 144 条样本外残差，估计 sigma 和经验 10%/90% 分位 |
| 间隔 | 10-14 | 保证首个留出日满足 D−2 可用性 |
| 留出检验 | 10-15–10-28 | 14 日、1,008 行；不再选择模型或调参 |

验证选出的 DA 模型为 Ridge α=10，价差模型为同小时 28 日均值。其留出 DA MAE **9.9305**，较 14 日均值基准 **7.1124** 更差；价差 MAE **9.0575**，较零价差基准 **8.6196** 更差。价差方向准确率 **51.09%**，固定负方向对照为 **50.89%**。名义 80% 区间的实际覆盖率为 DA **75.00%**、价差 **71.33%**。

`report.promotionGate` 标为 `research_only`，`approvedForTrading=false`。固定策略的 14 日零费用模拟净损益为 **−$59.15**、最大回撤 **$565.78**；固定 $1/MWh 费用敏感性为 **−$164.39**。没有根据这些留出结果改选其他赢家，也没有搜索交易参数以美化损益。

负荷、风光和 Outlook 仅有两日快照，缺少与训练期对齐的历史发布版本；本地 RTD 两份归档并集仅八日。它们经审计后保留为市场背景，未补造数据入模。GridStatus 尚未配置。审计见 `research/data-audit.json`。

### 前向预测、归档与页面联动

本次真正前向交易日为 **2026-10-30 PT**，72 条预测实际生成于 **2026-10-29T15:53:47.595Z**，训练截至 10-28 PT；早于前一日 09:55 PT 的研究截点。生产平台已于 **2026-10-29T15:56:04.984Z** 接收同一预测，归档收据位于 `public/data/forecast-lab/forecast-archive-receipt.json`。

页面“用这批预测运行模拟”会核对已有相同输入的预测批次，必要时按实际服务器时间保存，然后以 `timingPolicy=recorded` 运行并进入策略实验室打开结果。首次接收晚于截点时拒绝将其作为事前输入。未来实际价格与损益为 null。生产验证与 Python 同一输入的计划电量、条件预期值一致，保存后的冻结输入重放通过。

历史 `forecast-history.json` 使用当前真实生成时间，并单独保留理论决策截点，明确是历史重建；不导入为当时已存在的预测。全滚动诊断中的 10-08 以前点标记 `selectionEligibleAtAsOf=false`，桥接器拒绝拿这些点做正式留出模拟。价格历史可能包含官方修订，时间隔离不证明当时已获得同一价格版本。

### Python 使用

上传原件保留，仓库中另有未修改副本 `research/original_trading_strategy.py`。维护版为 `research/trading_strategy.py`，可读取原有 `meta / nodes / series` 结构；生成的 `embedded-data.json` 也已实际通过原件 CLI 兼容验证。维护版修正空值、零负价、仓位、前视、夏令时及不当 Sharpe 等问题。

```bash
python -m pip install -r research/requirements.txt
python research/forecast_pipeline.py
python research/build_strategy_input.py
python research/trading_strategy.py --data research/output/embedded-data.json --strategy normal --k 0.5
python research/trading_strategy.py --data research/output/holdout-input.json
```

预测程序默认选择尚未错过研究截点的后续日期，并检查该目标 D−2 日每个枢纽小时均完整；归档过期或缺失最新完整日会停止并要求更新数据。已过期的显式目标会拒绝，不回填 `issuedAt`。固定实验仍要求本次历史档案和预先声明的时间划分。更新训练样本、特征或协议后应新建实验，并使用新的未来样本评价，不能重复把已看过的留出窗称作独立测试。

`research/README.md` 详述模型协议，`research/PYTHON_INPUT.md` 详述输入及策略口径。网页可下载包含价格档案、源码、结果和 SHA-256 文件清单的 `caiso-forecast-research.zip`。完整重训在 Python 环境执行，Worker 不运行 Python；网页刷新只加载已发布实验，没有暗设定时训练任务。

验证包括 12 项模型时间/选型/新鲜度测试、15 组 Python 模拟检查、28 组 Python/TypeScript 对照、全部 1,008 个留出点独立指标复算、72 个前向点时间与摘要核对、真实生产预测归档和输入重放。合成测试仅验证逻辑，不作为预测准确率或损益样本。

规则来源：[Appendix A Market Close](https://www.caiso.com/documents/appendix-a-master-definition-supplement-as-of-may-29-2026.pdf)、[§11.3 结算](https://www.caiso.com/documents/section-11-california-iso-settlements-and-billing-as-of-jul-22-2026.pdf)、[§30.9 虚拟报价](https://www.caiso.com/documents/section-30-bid-and-self-schedule-submission-in-california-iso-markets-as-of-may-1-2026.pdf)。

## 10. v5 第二轮预测优化

「价格分析 → 电价预测」默认显示 V2，并保留 V1 切换。三个视图调整为优化对比、逐小时预测、Python 输入与复现。V2 报告、曲线、归档回执、模拟输入及下载链接绑定同一版本，运行时禁止切换实验。

价格档案扩为 180 个完整 PT 日、12,960 条配对小时。12 个候选按每日 D−2 信息边界滚动运行，分别选择日前价与价差组合，并固定保留 20% 基线权重。旧 Oct15–28 开发比较中，DA MAE 从 9.9305 降到 6.0803；价差从 9.0575 降到 8.6202，仍略高于零价差基线 8.6196。默认固定策略的 $1/MWh 净损益却从 -164.39 降到 -262.32 美元；页面靠前并列展示这一结果，不以精度改善替代收益证据。

同数据消融显示，56 日数据上的 V2 MAE 为 DA 6.0591、价差 8.5611；扩历史在该旧窗口未进一步降低误差。消融作为结果后诊断展示，没有据此更换主模型。成熟 131 日、五个跨月区间、所有固定策略门槛和费用情景完整保留。

Oct30 PT 的 72 条前向预测真实生成于 2026-10-29T16:46:16.719Z。默认门槛无合格信号，计划 0 MWh、未分配 12 MWh，未来实际损益为空。TS 引擎升级 2.0.1，修复未来零计划被错误归为已实现零收益的边界；判定使用冻结输入时间。旧记录保留，跨版本复算明确显示原版本与当前版本。平台接收和重放证据见 V2 `forecast-archive-receipt.json`。

完整说明及复算命令见 `research/OPTIMIZATION.md`；方法见 `OPTIMIZATION_V2.md`，数据见 `EXTENDED_HISTORY.md`，消融见 `ABLATION_V2.md`。新模拟输入在 `research/output-v2/`，网页下载完整 V2 ZIP 包。预先声明的 28 日观察窗不代表已设置自动训练，目前只有实际生成的首日前向预测。

## 11. v6 第三轮：决策收益研究

「电价预测」默认进入 V3 决策研究，内部保留“决策诊断 / 对比与稳定性 / 证据与复现”，V1/V2仍可切换。V3没有前向预测，页面明确标识，并提供直达原V2已归档逐小时预测的按钮。

补齐180日实际负荷与风光，共4,320个系统小时及完整分枢纽观测；通过现有TypeScript归一器独立核对43,200个数值。新增特征只使用D−2及更早实际数据；本次取得的修订历史不冒充当时首次发布版本。

新模型直接预测固定INC/DEC报价下“每提交MWh的扣费收益”，将未成交计为0，使用V2因果DA锚±10报价。固定比较不交易、V2原规则、Ridge收益、价格提升树收益、相同提升树加基本面五个方案，训练窗口固定56日，费用0/1/2/5仅重计同一冻结订单。

共同95日（Jul26–Oct28）$1/MWh结果：V2 -683.63美元，Ridge +1014.85美元，价格提升树 +1126.45美元，加基本面 -55.12美元。但旧Oct15–28三个新候选均比V2更差；费用升至2后前两者只剩+76.17/+217.45。页面靠前并列展示长窗、近期、回撤与成本敏感性，所有候选固定顺序展示，不按历史收益自动选赢家。

V1→V2的八种DA/spread/sigma输入交叉重算，将旧窗净损益变化-97.94美元分摊为DA报价锚-103.13、spread+25.09、sigma-19.89。该机制诊断解释了价格MAE与收益目标的差异，不证明未来因果效应。

V3独立运行器为 `research/decision_strategy.py`，输入为 `research/output-v3/decision-plan-input.json`；payoff不写进旧价格/价差字段。独立复算40个情景和16,328次逐订单对照全通过。完整包 `caiso-decision-research.zip` 包含原始公开基本面响应、冻结档案、代码、结果及SHA清单。入口说明见 `research/DECISION_DELIVERY.md`，方法见 `research/DECISION_V3.md`。本轮模型完成于2026-10-29T17:32:57.690Z，已过Oct30研究截点，因此未生成或回填V3事前批次。

## 官方来源

- [CAISO OASIS](https://oasis.caiso.com/mrioasis/logon.do)
- [OASIS FAQ](https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf)
- [Today’s Outlook](https://www.caiso.com/todays-outlook)
- [Supply](https://www.caiso.com/todays-outlook/supply)
- [Emissions](https://www.caiso.com/todays-outlook/emissions)
- [GridStatus 开源 CAISO 实现](https://opensource.gridstatus.io/en/latest/_modules/gridstatus/caiso/caiso.html)
- [GridStatus Hosted API](https://docs.gridstatus.io/developers)
