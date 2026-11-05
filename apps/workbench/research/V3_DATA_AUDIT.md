# V3 基本面历史补齐与可用性审计

## 已实际取得的数据

本轮直接请求 CAISO 公开 OASIS 接口，将 **2026-05-02 至 2026-10-28 PT 的 180 个完整交易日**负荷与风光实际值补齐。档案由两个报表各六个不超过31日的时间窗口构成，共12份原始响应。请求串行并至少间隔5.1秒，原ZIP及实际获取时间缓存于工作目录，凭据不参与请求。

| 数据 | 范围与数量 | 处理方式 |
|---|---|---|
| 实际负荷 | CA ISO-TAC，4,320小时 | 仅取系统区域，其他TAC或BAA不相加 |
| 实际光伏、风电 | NP15、SP15、ZP26，共25,920个分区资源小时 | 每个资源必须三个枢纽都完整才求和 |
| 系统风光汇总 | 各4,320小时 | 与当前平台TypeScript的固定枢纽顺序求和一致 |
| 派生净负荷 | 4,320小时 | `loadMw - solarMw - windMw`，明确是本地计算指标 |
| 缺失及补值 | 0个缺失小时，0个补造值 | 发现缺失应保留null，不插值、不补零 |

来源中有 **6,048个负的分区风光数值**及 **55个零值**，原样保留。负的夜间太阳能数值不是本程序推算或裁剪造成。例如May2 NP15首个小时的来源值为−7.6154 MW。本轮不将负值任意替换为0，也不据此推断具体设备原因。

字段范围：实际系统负荷19,194–49,942 MW；汇总光伏−83.42122–19,738.45386 MW；汇总风电54.44331–6,360.88055 MW。数值范围仅是这份历史档案的观察值，不代表市场硬上下限。

## 文件与输入合同

主档案为 `data/fundamentals-history-v3.json`，每个UTC小时只有一行：

```json
{
  "startUtc": "明确UTC小时起点",
  "endUtc": "明确UTC小时终点",
  "localDate": "YYYY-MM-DD",
  "localHour": "HH:00",
  "utcOffset": "-07:00",
  "loadMw": "CA ISO-TAC实际负荷，数值或null",
  "solarMw": "三个指定枢纽的完整光伏汇总，数值或null",
  "windMw": "三个指定枢纽的完整风电汇总，数值或null",
  "netLoadMw": "派生净负荷，数值或null",
  "renewablesByHub": "NP15/SP15/ZP26各自的solarMw与windMw",
  "publishTimeUtc": null,
  "quality": "complete或missing"
}
```

上述JSON是字段说明，不是可直接当作数值输入的样例。档案中的实际数值均为有限浮点数，时间字段均有确定格式。

档案内容摘要：`b5f327f327f11fd5afbd24e1a6893741f7285de43f27b418ccb2c3017ecea05e`。

完整文件SHA-256：`c2ae6cbc795bd401d88081142ee15d0e012c0a96d2e658cd6f1bab65fc7c8876`。

`public/data/forecast-lab/v3/fundamentals-audit.json` 保留每份响应的公开查询URL、实际获取时刻、原ZIP摘要、字段、解析计数和缺失/负值统计。`fundamentals-verification.json` 记录与现有TypeScript归一器的独立全量对照。

## 可进入模型的时间边界

本轮只允许使用目标日 **D−2或更早**的实际基本面，例如同小时D−2/D−7值、过去七日平均、D−2全天均值和峰值。目标日实际负荷、实际风光或事后净负荷不得进入该目标日预测特征。

**D−2是研究信息延迟假设，不是历史发布版本证明。** 当前拿到的是本次下载时可获得的历史版本，可能包含之后修订；原CSV没有逐条首次发布时间，全部 `publishTimeUtc` 保留null。记录的 `fetchedAt` 是今天实际取得响应的时间，不能倒填为历史截点。因此加入这些特征的历史评估仍是重建实验，不能冒充当时已经上线的收益记录。

本轮没有补造目标日官方预测，也没有为已经过去的预测截点生成新“事前”预测。新的模型效果必须由相同历史窗口、相同模型复杂度的价格特征/价格+基本面特征消融来判断，数据完整不等于已证明收益改善。

## GridStatus 与 Today’s Outlook 的口径

CAISO 官方FAQ明确：OASIS是市场输出口径，Today’s Outlook是遥测与汇总口径，两者不能直接当作同一真实标签。此次归档全来自OASIS，没有拼接Outlook值以填补缺失。

GridStatus开源实现的 `get_load_hourly` 与 `get_renewables_hourly` 同样读取这两个OASIS `ACTUAL` 报表。其常规日前负荷函数通过 `_add_load_forecast_publish_time`，按日程将交付日减一天并设为09:10 PT，生成 `Publish Time`；这并不是CSV中的实际首次发布时间。因此，不能仅凭这个字段声称历史日前预测已在对应截点可用。此处结论专指常规SLD_FCST路径，不泛化到另有真实发布字段的其他报表。

GridStatus托管API不是本次取数依赖，不需要配置商业API Key才能读取这些CAISO公开实际值。

## 核验与复现

```bash
# 首次联网取得数据；已有有效原响应缓存时仅重建
python research/v3_data_audit.py

# 四项针对性边界测试，均为合成输入、不算市场业绩
python research/test_v3_data_audit.py

# 使用现有平台TypeScript归一器独立复核全部原响应
node research/verify_v3_fundamentals.mjs
```

边界检查覆盖春季23小时/秋季25小时、重复冲突、区域范围、0与负值、缺少分区时不求不完整总和、时间字段必须有时区。独立TypeScript复核需要原ZIP缓存和项目Node依赖；模型复算直接读取已经冻结的标准化JSON即可，不必重新联网获取可能变化的版本。

## 主要来源

- [CAISO官方OASIS FAQ](https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf)：大多数报告39个月保留期、报告不同查询跨度、SLD_FCST和SLD_REN_FCST的ACTUAL参数、OASIS与Outlook差异。
- [GridStatus CAISO开源实现](https://opensource.gridstatus.io/en/latest/_modules/gridstatus/caiso/caiso.html)：`get_load_hourly`、`get_renewables_hourly`与常规负荷预测发布时间推导逻辑。

实际API响应与本地摘要是本次数量、范围和完整性的直接证据；上述文档用于确认字段与接口语义。
