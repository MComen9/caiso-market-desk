# CAISO 结算数据缺口与公开证据

核对日期：2026 年 10 月 30 日。公开节点样本查询交易日为 2026 年 10 月 28 日（美国太平洋时间）。数据是本次获取版本，不是该交易日前的历史快照。

## 当前结论

现有 V1—V3 采用的小时 FMM 能源清算价格具有官方依据，但费用和交易节点资格尚不足以支持完整的虚拟交易收益核对。本轮找到并保存了官方结算指南、2026 年费率、节点资格列表及失败请求证据。

**最关键的三个缺口：**

1. 当前研究的三个全时段枢纽 ID 未出现在本次虚拟交易合格节点列表；列表中存在的是各枢纽的 ONPEAK/OFFPEAK 节点，需要补充峰谷时段、申报节点和价格之间的映射。
2. **最终有效提交的虚拟报价段按 $0.005/段收取 CC4515 费用，未成交也可能收费。** 当前仅按成交 MWh 扣费的假设不完整，未成交订单不能在全成本模型中一律视为零成本。
3. 2026 年虚拟交易还需考虑 Forecasted Movement 结算和适用的分摊。公开能源价格与统一费用假设不足以复原最终结算单。

本轮新增证据没有回写或重算旧版历史收益，避免改变已经冻结的实验口径。

## 1 节点资格与时段映射

本次匿名 OASIS `ATL_CBNODE` 返回 3,568 行。三个当前研究节点的精确 ID 均未匹配；找到以下六个相关虚拟交易节点：

| 当前价格研究节点 | 本次列表中的相关节点 |
|---|---|
| `TH_NP15_GEN-APND` | `TH_NP15_GEN_ONPEAK-APND`、`TH_NP15_GEN_OFFPEAK-APND` |
| `TH_SP15_GEN-APND` | `TH_SP15_GEN_ONPEAK-APND`、`TH_SP15_GEN_OFFPEAK-APND` |
| `TH_ZP26_GEN-APND` | `TH_ZP26_GEN_ONPEAK-APND`、`TH_ZP26_GEN_OFFPEAK-APND` |

六个匹配记录的生效起止时间均为 PT 2011-01-26 00:00:00 至 2030-12-31 23:59:59；原始 UTC 字段为 2011-01-26T08:00:00-00:00 至 2031-01-01T07:59:59-00:00。未来结束日期仅是该版本数据的有效期字段，不能保证未来不会调整。

这项结果说明“价格参考节点”与“可申报节点”需要明确映射，不能把字符串相似当作资格验证。它也不等于三个枢纽完全不能参与虚拟交易。官方 SIBR 用户指南展示的虚拟报价示例使用 ONPEAK/OFFPEAK 节点，与本次列表一致。

下一步需按官方 `ATL_PEAK_ON_OFF` 核对交易小时和节假日，再验证六个节点的 DAM/FMM 价格、节点限额和节点组约束；不能直接用普通工作日或自行定义的峰谷代替 WECC 时段。当前三个全时段 ID 的 `CB_NODAL_LIMITS` 请求均返回 OASIS 1000“该选择没有返回数据”，**未返回不代表无上限、无限额或自动合格**。

原始资格 ZIP、对应请求收据、三次限额错误响应和精确匹配结果包含在证据包。资格核对结果是当前下载版本上的检查，尚未证明历史每一天的申报资格。

来源：[OASIS 接口规范](https://www.caiso.com/documents/oasis-interfacespecification_v5_1_1clean_fall2017release.pdf)、[SIBR 用户指南](https://www.caiso.com/documents/sibr_scuserguidewebsdk35v71.pdf)。

## 2 已取得的官方费率

以下金额已与 CAISO 2026 年 10 月 1 日生效费率 PDF 的第 2 页核对；适用基数来自 CC4515、CC4560 指南。

| 费用 | 生效时间 | 数值 | 适用基数与限制 |
|---|---|---:|---|
| CC4560 市场服务费 | 2026-01-01 至 2026-09-30 | $0.1416/MWh | 虚拟需求成交量绝对值与虚拟供给成交量绝对值之和；不按日前和实时两腿简单乘二 |
| CC4560 市场服务费 | 2026-10-01 起，本次查得版本 | $0.1216/MWh | 同上；将来变化应按新版本及效期处理 |
| CC4515 报价段费 | 2026 年，本次查得版本 | $0.005/段 | 最终有效提交的非零虚拟报价段；不以成交为前提；实际账户例外标记需核对 |
| CC4575 SCID 月费 | 2026 年，本次查得版本 | $1,500/SCID/月 | SC 层面固定费用；单策略承担比例及代办服务费由实际合同决定 |

CC4515 按报价段计数，CC4560 按成交电量计费，SCID 月费按月计费，三者不能合并成同一个固定的每 MWh 参数而声称完整。经纪/SC 服务费、信用资金成本和结算分摊仍需实际安排或结算单。

对于现有仿真，若一个小时在一个节点提交一段有效报价但未成交，能源价差收入为零；在无适用豁免的假设下，提交费仍为 $0.005。该例只解释费率基数，不代表完整结算。

来源：[2026 年费率原件](https://www.caiso.com/documents/grid-management-charge-rates-2004-2006-effective-oct-01-2026.pdf)、[CC4515 指南](https://www.caiso.com/documents/cg-cc-4515-gmc-bid-transaction-fee-incremental-update.docx)、[CC4560 指南](https://www.caiso.com/documents/cg-cc-4560-gmc-market-services-charge.docx)。

## 3 能源价格与 Forecasted Movement

CC6473 及 2026 年官方培训明确，内部合格节点的虚拟交易能源清算使用同小时四个 15 分钟 FMM LMP 的简单平均。不能用 5 分钟 RTD LMP 或 Hourly RTM LAP 价格直接替代该口径。

2026 年指南还包含虚拟 Forecasted Movement 结算。需要逐小时虚拟成交量、前一天最后一小时的成交量、虚拟移动量以及节点 FMM FRU/FRD 价格。该项金额按移动量与小时平均 FRU/FRD 节点价差计算，结算符号、方向、BAA 和最终修订版本应与原始 bill determinants 对齐。

`PRC_FLEX_RAMP` 的约束/影子价格不等于节点 FRU/FRD 价格。公开 OASIS 节点价格入口可以支撑研究计算；自己的实际成交与移动量记录、最终金额核对仍需要参与者结果。

来源：[CC6473 指南](https://www.caiso.com/documents/cg-cc-6473-convergence-bidding-real-time-energy-congestion-and-loss-settlement-incremental-update.docx)、[2026-04-21 结算培训](https://www.caiso.com/documents/presentation-dame-edam-and-edam-caiso-balancing-authority-participation-rules-settlements-refresher-training.pdf)、[2026-06-17 结算用户组记录](https://www.caiso.com/documents/agenda-settlement-user-group-jun-17-2026.pdf)。

## 4 公开数据与授权数据的边界

| 数据 | 获取渠道 | 本轮能补到的范围 | 仍需补充 |
|---|---|---|---|
| 节点资格、节点限额、节点组约束 | OASIS | 资格列表已下载，当前研究 ID 的限额失败响应已保留 | 六个相关申报节点的时段映射、对应限额与历史版本 |
| FMM 节点 FRU/FRD 价格 | OASIS | 已确认官方报告存在；实际可用状态以采集收据为准 | 完整区间、完整节点、与移动量结算对齐 |
| 公开费率和计费规则 | CAISO 文档 | 2026 费率及相关指南已取得 | 账户豁免、SC 合同和策略分摊比例 |
| 节点/系统虚拟出清量 | OASIS | 公共聚合结果可作为市场行为数据 | 不提供自己的订单成交证明；节点净量也不能替代分方向成交 |
| 季度信用参考价 | OASIS `PRC_DS_REF` | 公共参考数据可获取 | 实际保证金、可用信用、融资利率和信用占用 |
| 自己的申报和成交、虚拟移动量 | SIBR、CMRI | 无参与者身份时不能公开补齐 | 用户授权结果或数据导出 |
| 最终结算、分摊、调整及修订 | MRI-S | 规则公开 | 结算单、发票、bill determinants、适用结算版本 |

CMRI 和 MRI-S 的官方应用入口要求证书。接口文档可查不代表任何账户的数据可以匿名下载；公开总量不能补成账户级完整结算。[CMRI](https://www.caiso.com/systems-applications/portals-applications/customer-market-results-interface-cmri)；[MRI-S](https://www.caiso.com/systems-applications/portals-applications/market-results-interface-settlements-mri-s)。

## 5 证据包与复核

平台文件目录为 `public/data/data-gaps/settlement-evidence/`：

- `settlement-gap-evidence.json`：入口元数据，包含费用、缺口、来源和节点资格检查摘要。
- `node-eligibility-check.json`：三个精确研究 ID 与六个相关申报节点的检查结果。
- `public-document-receipts.json`：官方文档获取时间、URL、字节数及 SHA-256。
- `manifest.json`：交付文件清单及 SHA-256。
- `download-evidence.zip`：公开文档原件、原始 OASIS 证据、元数据及本说明。

原件均来自 California ISO，保留原有版权、商标及其他标记，供来源核对；说明和结构化结果由本平台整理。官方材料的使用条件见 [CAISO Privacy and Terms of Use](https://www.caiso.com/privacy-terms-of-use)。

证据包只纳入公开文档及匿名市场查询响应，不包含账户数据或凭据。文件完整性核对不能代替结算业务验收。完整成本、节点资格映射和实际成交核对完成之前，旧实验应继续标为研究仿真。
