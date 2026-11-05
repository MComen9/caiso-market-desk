# Python 预测输入与策略模拟

本目录把实际训练得到的价格预测送入用户上传的 `trading_strategy.py` 所使用的 `meta / nodes / series` 数据结构。`research/trading_strategy.py` 是另行维护的修正版，上传原件保持不变。

## 一次完整运行

在工程根目录执行：

```bash
python research/forecast_pipeline.py
python research/build_strategy_input.py
python research/trading_strategy.py --data research/output/embedded-data.json
python research/trading_strategy.py --data research/output/holdout-input.json
python research/trading_strategy.py --data research/output/holdout-input.json --fee-per-mwh 1
```

模型程序读取已保存的真实 OASIS 价格档案，不在运行时偷偷改用人工价格。预测日期和实际生成时间由模型输出决定；若已错过交易日前一日 09:55 PT 的研究截点，须使用后续可用交易日。不得把发布时间改写成过去。

只运行策略模拟无需第三方 Python 包；标准库 `zoneinfo` 需要系统的 IANA 时区数据。模型训练依赖另见模型目录的 requirements。

## 产物

| 文件 | 内容 | 使用范围 |
| --- | --- | --- |
| `embedded-data.json` | 前向价格预测、实际价格为 null、三个枢纽与 UTC 小时 | 维护版；正常 24 小时日也兼容上传原始脚本 |
| `holdout-input.json` | 未参与选型的检验期预测、真实历史 DA/FMM、重建标记 | 维护版历史研究 |
| `forward-plan.json` | 固定策略参数下的模拟报价、方向和电量 | 前向计划；实际盈亏为 null |
| `holdout-simulation.json` | 固定参数的检验期逐日、逐小时研究结果 | 非当时归档业绩 |
| `holdout-fee-1-sensitivity.json` | 相同计划下，按每模拟成交 MWh 收取 1 美元的敏感性 | 不代表完整市场费用 |
| `simulation-summary.json` | 网页展示所用的精简汇总 | 与详细结果同次计算 |

主要输入和模拟结果保存在 `research/output/`，网页下载副本在 `public/data/forecast-lab/`，这两处对应文件采用完全相同的字节。网页精简汇总 `simulation-summary.json` 仅位于 `public/data/forecast-lab/`。

## 输入字段映射

每个节点对应一个 `series[node]`，数组顺序与顶层 `hours` 完全相同。`hours` 使用带时区的 UTC 起止时刻，在加州夏令时转换日保留 23 或 25 个小时。

| 数组位置 | 含义 | 单位 / 缺失值 |
| --- | --- | --- |
| `r[0]` | 小时开始 UTC | ISO 8601 |
| `r[1]` | 实际日前 LMP | 美元/MWh；未知为 null |
| `r[2]` | 实际四个 FMM 价格的小时简单均值 | 美元/MWh；不足四个时为 null |
| `r[3]` | 预测 FMM − DA | 美元/MWh |
| `r[4]` | 预测日前 LMP | 美元/MWh |
| `r[5]` | 样本外价差残差尺度 sigma | 美元/MWh；不是胜率 |
| `r[6]` | 模型版本 | 字符串 |

平行数组 `forecastProvenance[node]` 保留每个预测的实际 `issuedAt`、实际 `generatedAt`、理论决策截点 `decisionAsOfUtc`、训练数据终点 `trainingEndUtc`、训练和校准样本数，以及 `reconstructed` 标记。

预测文件及输入文件 `meta.generatedAt` 表示模型实际生成预测的时间。模拟结果另用 `executedAt` 表示本次模拟计算完成时间，`forecastGeneratedAt` 保留其所用预测的生成时间；结果的 `generatedAt` 是结果生成时间。`simulation-summary.json` 的 `generatedAt` 为汇总文件创建时间，`executedAt` 为所汇总三次计算中最晚的完成时间。重跑模拟不会改写预测的 `issuedAt` 或预测摘要。

历史重建允许当前计算过去的预测，但会明确标记为 `historical_reconstruction`。它只验证训练终点不晚于理论截点，不能证明历史数据版本当时已发布，也不能证明预测当时已存在。前向预测另外要求实际 `issuedAt` 不晚于决策截点。

## 固定策略参数

所有检验期结果使用事先固定的参数，没有根据检验期收益寻找更优交易参数：三个枢纽显式手选、`normal` 顺势、`k=0.5`、每日电量预算 12 MWh、每格上限 2 MWh、每节点每天 6 MWh、最多 12 格、报价偏移 10 美元/MWh。每个计划格至少 1 MWh，允许小数电量。默认费用为零，另给出固定 1 美元/MWh 的费用敏感性。

预测价差为正时选择 DEC，负时选择 INC。`k × sigma` 是研究信号门槛；预测未通过门槛时允许不分配仓位。预期损益假设全部计划量成交，不是经成交概率校准的收益预测。

## 对上传原件的兼容性

原始脚本可以这样读取生成的前向输入：

```bash
python research/original_trading_strategy.py --data research/output/embedded-data.json --strategy normal --k 0.5
```

这条命令用于确认输入结构可用。原件仍保留旧网页的固定 24 小时索引、静态节点排名和不足时补选、空值按零以及 252 日年化 Sharpe 等行为；其未来日汇总 `pnl=0` 也不能解释为已实现的零收益。因此网页研究结果和正式本地复算应使用随附的维护版。

旧 CLI 必须读取 `nodes[].strat` 的 `n/win/ev/pf` 数值字段。前向输入把这些字段显式标成 `statsAvailable:false`，数值零只是结构占位，含义是未估计，并非历史胜率或收益。维护版不使用这些字段，也不会根据它们补选节点。

## 维护版修正

- 在读取目标日实际价格前完成候选、方向、报价与电量分配；改变目标日实际价格不会改变计划。
- null 保持缺失；有效零价和负价保持原值。缺失 DA/FMM 的计划仍显示，实际盈亏留空。
- 完整四个 FMM 才参与结算模拟。恰好等于 DA 的报价默认不假定成交。
- 仓位遵守每日预算、节点预算、格数、每格最小与最大电量。高门槛策略使用 `max(k, 1.5)`。
- 不使用全区间预计算节点统计，不自动放宽门槛补选。不计算年化 Sharpe。
- 未来计划和不完整历史日的主盈亏保持 null；完整且没有信号的历史日可以是零。
- 实际成交、电价影响、Forecasted Movement、uplift、信用资金和其他完整结算项目未建模。

## 验证

```bash
python research/test_strategy_bridge.py
python research/test_strategy_bridge.py --export-parity
node research/test_strategy_parity.mjs
```

测试使用明确标注的合成数据，仅验证数值和时间口径。15 组 Python 回归检查覆盖缺失、零负价、无前视、仓位、费用、时间截点、模型选型可用时点及夏令时；28 组 Python / TypeScript 对照检查覆盖七类策略和不同实际行情状态。它们不用于报告市场收益。
