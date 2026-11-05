# CAISO 第三轮决策研究：交付与复现

本包包含已实际完成的 V3 决策研究，以及用于对照的 V1/V2 冻结输入和结果。**V3 是历史开发研究，没有新的事前预测或交易申报。**原先在截点前归档的 V2 Oct30 预测仍独立保留。

## 结果先看这里

评价窗口为 **2026-07-26–10-28 PT，95 日、6,840 个节点小时**。下面各方案使用同一实际行情、每日电量约束与 $1/MWh 成交费用假设。

| 方案 | 95 日净损益 | 最大回撤 | 已见 Oct15–28 净损益 |
|---|---:|---:|---:|
| 不交易 | $0.00 | $0.00 | $0.00 |
| V2 原规则 | -$683.63 | $1,807.97 | -$262.32 |
| Ridge 收益模型 | +$1,014.85 | $1,504.48 | -$425.60 |
| 浅层提升树，仅价格 | +$1,126.45 | $644.70 | -$334.32 |
| 相同提升树，加入滞后基本面 | -$55.12 | $962.25 | -$551.56 |

两个候选在较长历史窗口为正，但三个新方案在最近旧14日均退化。将费用提高到 $2/MWh，前两者只剩 +$76.17、+$217.45；$5/MWh 时所有交易方案亏损。不交易没有暴露，零收益不能称作预测优势。历史已用于开发，不存在新的独立未见检验。

默认查看的 Ridge 在协议冻结时指定，不是看完结果后选出的赢家。方法、参数、月份、八种输入交叉诊断和限制详见 `research/DECISION_V3.md`；实际报告在 `public/data/forecast-lab/v3/report.json`。

## 本轮的输入输出区别

V1/V2 预测电价与 FMM−DA 价差，继续使用 `research/trading_strategy.py` 和原 `meta / nodes / series` 合同。V3 预测**固定报价下每提交 MWh 的扣费收益**，其中未成交的收益为0。这不是电价、价差或获利概率，因此使用独立合同：

| 文件 | 含义 |
|---|---|
| `decision-points.json` | 每节点小时 INC/DEC 两种动作的收益预测、报价锚与信息截点 |
| `decision-plans.json` | 五种规则逐日形成的订单与研究评估结果，含无订单日期 |
| `decision-plan-input.json` | 独立运行器输入：冻结订单、约束、实际行情和摘要，订单与实际行情分开 |
| `replay-verification.json` | 独立运行器对全部40种窗口/规则/费用情景及逐笔收益的复算记录 |

标准库运行器只重放已经冻结的订单，不重新训练或挑选候选。改费用时，原订单方向、报价和电量完全不变，仅对模拟成交电量扣费。

## 最快复算，不需要训练依赖

解压后在项目根目录执行：

```bash
# 95日Ridge方案，费用为1美元/MWh
python research/decision_strategy.py --data research/output-v3/decision-plan-input.json --policy ridge_payoff --fee-per-mwh 1 --output ridge-replay.json

# 同一份价格提升树订单，检查费用升至2美元/MWh的结果
python research/decision_strategy.py --data research/output-v3/decision-plan-input.json --policy hist_payoff_price --fee-per-mwh 2 --output tree-fee2-replay.json

# 只评价已经看过的14日开发窗口
python research/decision_strategy.py --data research/output-v3/decision-plan-input.json --policy ridge_payoff --start-date 2026-10-15 --end-date 2026-10-28 --output recent-replay.json

# 由冻结模型产物重新封装输入，并独立复核所有固定情景
python research/build_decision_input.py
```

可选 `--policy` 为 `no_trade`、`v2_original`、`ridge_payoff`、`hist_payoff_price`、`hist_payoff_fundamentals`。网页单独下载的运行器和输入放在同一目录时，命令可以简化为 `python decision_strategy.py --data decision-plan-input.json --policy ridge_payoff`。

输入指纹不匹配、重复节点小时、同格双方向、无效PT日期、超限电量、晚于 D−2 的训练标签、未来日期冒充历史等情况会停止执行。实际缺失不会补零；完整历史无订单时为零，且胜率为空。

## 重训与数据来源

```bash
python -m pip install -r research/requirements.txt
python research/decision_pipeline.py
python research/test_decision_pipeline.py
python research/test_decision_strategy.py
python research/test_v3_data_audit.py
```

完整重训需 numpy / scipy / scikit-learn；冻结订单重放仅需 Python 标准库。训练只使用各目标日 D−57 至 D−2 的56日，标准化和缺失处理仅在本次窗口拟合。价格特征67个，基本面另外20个；候选、成本和门槛固定，没有收益网格选优。

新增 `data/fundamentals-history-v3.json` 包含180日4,320个完整UTC系统小时。负荷取 CA ISO-TAC；风光取 NP15/SP15/ZP26 完整汇总；净负荷为本地派生值。全部43,200个系统及分区数值已与平台TypeScript归一器独立核验。原始公开响应与获取元数据放在 `.sites-runtime/v3-fundamentals/`，便于不联网重建解析；这些文件不包含任何登录凭据。

如需重跑原响应的独立TypeScript核验，可先执行 `npm install`，再执行 `node research/verify_v3_fundamentals.mjs`。本包的Node依赖仅用于源码对照，不启动平台服务。

历史实际版本可能包含官方修订；原始发布时间未知时保留null，不能把推定日程当作历史发布凭证。数据审计见 `research/V3_DATA_AUDIT.md`。本轮完成时间为 **2026-10-29T17:32:57.690Z（北京时间10月30日01:32:57）**，晚于Oct30研究截点，所以V3没有前向批次。模型结构标注为最后一个历史评价日拟合，不能误认为未来已发布模型。

## 完整性与使用边界

ZIP通过CRC检查；根目录 `release-manifest.json` 列出所有交付成员的字节数和SHA-256。`replay-verification.json` 记录40个情景和16,328次逐订单对照全部一致。数据完整性、模型时间边界和运行器各有针对性测试，合成测试不计为市场业绩。

这些结果采用报价交叉即全量模拟成交、小时FMM均价、研究电量上限和简化费用。它们不包含完整官方结算、Forecasted Movement、其他分摊、信用资金及真实可成交容量，也没有下单。长窗口为正的候选仍需新的事前归档数据验证。
