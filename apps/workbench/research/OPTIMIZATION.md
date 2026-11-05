# CAISO 第二轮预测与 Python 模拟交付

这是已经运行完成的研究包。主预测版本为 `caiso-price-forecast-2.0.0+75e28d6e07da`，状态为 `research_only`。本包同时保留第一轮结果，便于逐点核对；新结果位于 `public/data/forecast-lab/v2/`，模拟输入位于 `research/output-v2/`。

## 已完成的实际结果

OASIS 价格历史从 56 日扩到 **180 个完整 PT 交易日（2026-05-02–10-28）**，包括 NP15、SP15、ZP26 三枢纽的 **12,960** 条小时记录。每条 FMM 是同小时四个完整 15 分钟时段的均值；负价、零价保留，缺失不补零。新增 8,928 行已与平台 TypeScript 聚合结果逐行一致核验。

V2 实际比较 12 个候选；每个预测日仅使用 D−2 及更早的标签、特征、滚动选择误差和残差。日前价与价差分别选型，组合固定保留 20% 简单基线权重。详细冻结规则见 `OPTIMIZATION_V2.md`，数据审计见 `EXTENDED_HISTORY.md`。

| Oct15–28 已见开发窗口 | V1 | V2 | 简单基线 |
|---|---:|---:|---:|
| DA MAE，美元/MWh | 9.9305 | 6.0803 | 7.1124 |
| FMM−DA MAE，美元/MWh | 9.0575 | 8.6202 | 8.6196 |
| 原固定策略零费用净损益，美元 | -59.15 | -196.32 | 不适用 |
| 原固定策略 $1/MWh 净损益，美元 | -164.39 | -262.32 | 不适用 |

日前价误差改善约 38.77%，价差改善约 4.83%，但价差仍略差于零价差基线，默认策略收益也变差。因此本轮没有达到可用于实盘交易的证据要求。旧窗口已经被查看，不能重新称作未见测试。

固定 V2 方法在原 56 日数据上的消融得到 DA MAE 6.0591、价差 MAE 8.5611；扩到 180 日后，该旧窗口误差分别上升约 0.0212、0.0591。近期改善主要来自方法变化，不能归因于数据量增加。消融是结果后诊断，没有据此替换主预测。详情及区间宽度对比见 `ABLATION_V2.md`。

## 实际前向预测与模拟

主预测于 **2026-10-29T16:46:16.719Z（北京时间 10-30 00:46:16）**实际生成，目标 **2026-10-30 PT**，共 **72** 个节点小时。声明发布时间不回填为历史时点。平台实际接收时间与冻结输入重放结果，以 `public/data/forecast-lab/v2/forecast-archive-receipt.json` 为准。

当前默认 `normal, k=0.5` 下无合格信号：计划 **0 MWh**，未分配 **12 MWh**。72 点预测完整；零计划不是缺少输入，也不意味着已实现零收益。未来实际 DA、FMM 和损益均为空。TS 引擎 2.0.1 修复了未来空计划错误计作已评价零收益的边界，并按冻结输入时间重放；旧引擎结果保留，跨版本复算明确显示版本变化。

预先声明的前向观察窗为 Oct30–Nov26，共 28 日。目前只生成了实际存在的一天；未设置无人值守定时训练或未来预测。

## 直接运行现有 Python 文件

在解压目录根部执行。模拟器仅需 Python 标准库；仅在重训模型时需要安装 `research/requirements.txt`。

```bash
# 读取已经冻结的 72 点预测，输出未来计划；实际损益为空
python research/trading_strategy.py --data research/output-v2/embedded-data.json --strategy normal --k 0.5 --output forward-replay.json

# 使用相同已见开发窗口复算，加入每 MWh 1 美元的费用假设
python research/trading_strategy.py --data research/output-v2/holdout-input.json --strategy normal --k 0.5 --fee-per-mwh 1 --output development-replay.json

# 从已保存模型结果重建输入并运行所有固定门槛/费用情景
python research/build_optimization_input.py
```

`embedded-data.json` 为原模拟程序兼容的 `meta / nodes / series` 结构，另含明确时间、预测版本、摘要与空值语义。维护版为 `research/trading_strategy.py`；原文件保留在 `research/original_trading_strategy.py`。预测与实际数据分开保存，计划形成后才按实际价格计算模拟成交和收益。

`holdout-input.json` 沿用原接口文件名；V2 中该文件明确标记 `previously_seen_development`，文件名不赋予它独立测试地位。三种预定信号门槛、两种费用、两个版本共 12 个情景全部报告在 `strategy-comparison.json`，没有按结果自动选择盈利最高的参数。

## 重训与复核

```bash
python -m pip install -r research/requirements.txt
python research/test_extended_history.py
python research/test_optimization_pipeline.py
python research/optimization_pipeline.py --input data/strategy-history-expanded.json
python research/build_ablation_report.py --run
```

重训会写入新的真实生成时间；过期目标不能重新生成并冒充事前预测。默认目标需要对应 D−2 日的完整价格，过期档案会阻止新的前向输出。为保持本次证据，复算原计划应直接使用本包冻结输入，不必重训。更改候选、窗口或组合规则应保存为新实验。

发布包包含逐文件 SHA-256 的 `release-manifest.json`，ZIP 已进行 CRC 及所有成员摘要校验。模型产物保留真实运行时间、输入 SHA-256、候选预测、逐点评价及不利月份。新增检查包括 5 项数据边界、8 项优化模型检查，以及未来无信号、历史完成无信号和墙钟推进后的冻结重放；策略另通过 20 项对抗检查和 28 组 Python/TypeScript 对照。

## 解释边界

本轮是价格历史驱动的研究。负荷、风光与 Today’s Outlook 只有短期快照，缺少与本次训练期对齐且可证明决策前可用的发布版本，未补造进入训练；GridStatus 尚未配置。本次 FMM−DA 模拟只覆盖能量价差及填写的费用，报价交叉采用模拟成交假设，未涵盖正式结算的全部项目。历史价格可能有修订，按时间隔离的重建不能证明当时首次发布值。

更长 131 日成熟滚动窗口的 MAE 为 DA 8.6715、价差 7.9271，分别低于相应基线 9.4143、8.2453；默认 $1/MWh 策略仍为负净损益（约 -163.47 美元）。价格误差、区间覆盖、成交暴露和策略收益应分别评价。
