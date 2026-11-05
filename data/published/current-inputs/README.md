# 当前可实现的数据输入

本轮只使用无需采购、无需新增账户的公开数据。采集已结束；未取得的内容从本轮输入中排除，不阻塞预测。

| 材料 | 实得覆盖 | 本轮用途 |
| --- | --- | --- |
| `price-history-current.json.gz` | 2025-10-29—2026-10-29 PT，366 天、26,352 节点小时 | V4 核心预测输入；原 365 天行逐值保留 |
| `price-addendum.json`、`oasis/` | 新增 10/29 三枢纽 72 个 DAM 小时和 288 个 FMM 区间；2 个原始 ZIP 与回执 | 核验新增价格与离线重放 |
| `eia/eia930-ciso-current.json.gz` | 同期 8,784 系统小时，19 个有有效值的数值列 | **研究参考，未进入本轮 V4 核心训练** |
| `optional/` | FRP 单日请求及一次处理中重试仍返回 OASIS 1015 | 已排除，不再继续请求 |

EIA 的电池储能、抽水蓄能和 CFE 交换三列在本区间全部为空，保留 `null` 并排除，未以零值填充。其余字段仍有少量空值，各列有效数和最新日期见 `eia/eia930-ciso-audit.json`。天气历史、需授权或采购的数据均不作为本轮依赖。

## 口径与证据

- CAISO 价格为 USD/MWh；仅一个有效 DAM 小时及四个有效 FMM 区间完整配对后形成小时数据。
- EIA 源时间是小时结束；归一开始时间向前移动一小时。源值为该小时 MWh，除以一小时得到平均 MW，数值不变。净交换负值为流入、正值为流出。
- EIA 保留原报告值，未使用其 imputed/adjusted 列替换；因此图表中的零值不代表原报告具有相同观测。
- 本次取得的是当前历史版本，可能包含修订。真实接收时间、原始文件 SHA-256 和 URL 均保留；未将其解释为历史首次公开时间。
- 97.9 MB 的 EIA 原始工作簿未进入交付目录或前端。来源 URL、SHA-256 和响应信息在 `eia/receipt.json`；交付与 V4 重放使用已保存的归一面板。
- `manifest.json` 保存本目录各文件及相关脚本的哈希。已冻结 V4 输入另由 V4 产物中的输入快照和哈希绑定。

## 离线重放价格

从项目根目录运行；使用已有 365 天基线和本目录原始响应，不发起网络请求：

```bash
python research/current_data_acquisition/normalize_current_prices.py --baseline public/data/data-gaps/price-history-365d.json.gz --input-dir public/data/current-inputs/oasis --date 2026-10-29 --output .sites-runtime/current-inputs-replay
```

归一行应与交付一致。重新运行的生成时间和文件整体哈希会改变；保留本次交付原件即可复现已冻结模型输入。

## 可选的后续更新命令

以下命令会访问公开互联网，本次整理未再次执行。每个 OASIS 报告请求有数量和等待预算；HTTP 200 内的 XML 错误不会记为数据成功。

```bash
python research/current_data_acquisition/fetch_current_public.py --date 2026-10-29 --output .sites-runtime/current-inputs-refresh/oasis
python research/current_data_acquisition/fetch_eia.py --raw-cache .sites-runtime/current-inputs/eia --output .sites-runtime/current-inputs/eia
python research/current_data_acquisition/normalize_eia.py --raw-file .sites-runtime/current-inputs/eia/CISO.xlsx --receipt .sites-runtime/current-inputs/eia/receipt.json --output .sites-runtime/current-inputs/eia --start 2025-10-29 --end 2026-10-29
```

OASIS 获取和价格归一只需 Python 标准库；EIA 归一需要 `openpyxl`。脚本使用相对项目默认路径，也接受显式输入输出路径。新的下载可能取得修订值，须作为新版本保存；不得覆盖已经用于某次模型运行的输入快照。
