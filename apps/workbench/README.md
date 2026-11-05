# CAISO 本地研究工作台

本工程保留完整行情接口、交互工作台、Python 研究算法、输入档案和冻结模拟输出，供研究、研发及 Codex 继续维护。**团队公开浏览入口由 `../viewer` 发布到 GitHub Pages；本工程的 API 和数据库只在本地运行。**

迁移保留了原工作台的业务代码，移除了旧托管身份、固定私有网址、未使用的连接器预览脚手架和登录模拟。没有导出原生产数据库、账号凭据或后台任务。当前没有自动抓数、定时重训或实际下单。

## 当前预测基线：V4

| 项目 | 已冻结事实 |
|---|---|
| 模型版本 | `caiso-current-data-4.0.0+99bd6a8751fe` |
| 真实生成时间 | 2026-10-30 08:34:02.166 UTC |
| 预测目标日 | **2026-10-31 PT**，3 个枢纽 × 24 小时，共 72 点 |
| 实际训练输入 | 2025-10-29—2026-10-29 PT，366 天、26,352 个节点小时 |
| DA 模型 | `ridge_all` |
| 价差模型 | `shrink14`：14 日同小时中位数 × 50% |
| FMM | DA＋价差的派生值，没有独立训练 FMM 模型 |
| 历史开发评估 | 2026-10-02—10-29 PT，28 天、2,016 点，DA MAE 10.22450、价差 MAE 9.18872 美元/MWh |

这是已有历史快照，迁移不会刷新预测。历史窗口已经用于开发，不是新的独立测试。未来实际 DA/FMM/价差保留 `null`；零计划也不能伪装为已实现零收益。`research/README.md` 是 **V1 历史文档**，V2/V3 保留各自协议和结果；最新说明及准确数字见同步后的 `public/data/forecast-lab/v4/README.md`、`report.json` 和仓库根 `docs/CODEX_HANDOFF.md`。

## 目录职责

| 目录 | 内容 |
|---|---|
| `app/`、`components/` | 原交互工作台和 API 路由 |
| `lib/` | CAISO/OASIS/Outlook 解析、时区、策略引擎、数据契约和存储 |
| `worker/`、`wrangler.jsonc` | Vinext/Cloudflare 本地运行入口；非本地 URL 默认拒绝 |
| `db/`、`drizzle/` | D1 类型和数据库迁移 |
| `data/` | 算法及接口使用的既有价格与供需输入，保持原字节 |
| `research/` | V1—V4 源码、协议、数据审计、测试和冻结输入/输出 |
| `scripts/` | 构建辅助、公开数据同步、原有回归、V4 重放 |
| `public/data/` | 从仓库根 `data/published/` 同步的本地副本，忽略提交 |
| `docs/LEGACY_WORKBENCH_HISTORY.md` | 原平台历史交付记录，旧平台版本号不等同于当前模型版本 |

公开数据只有仓库根 `data/published/` 一份权威快照。构建不会修改它；`npm run data:sync` 会重建本工程的本地副本。V2/V3 下载引用已改为经过审查的公开结果包；V4 完整复现包保持原件。

## 安装、验证与本地启动

要求 Node.js ≥ 22.13（建议 22 LTS）及 npm；冻结模拟重放仅需 Python 标准库。以下命令从 `apps/workbench` 运行：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` 和 `npm run build` 会先同步公开数据。测试覆盖价格和基本面归一、夏令时、缺失/零/负值、策略信息时间边界、预测导入和 SQLite 模拟 D1 重放。测试只创建忽略的本地夹具，不连接原数据库、不抓新数据。

需要实际使用本地工作台时，再初始化本机开发数据库并启动：

```bash
npm run db:init
npm run dev
```

打开 `http://127.0.0.1:5173/`。`db:init` 只应用 `drizzle/` 到本地 Miniflare 数据库；配置中的全零数据库编号是本地占位，没有绑定任何远程账户。构建后也可用 `npm start` 运行本地构建产物。

开发服务默认监听 `127.0.0.1`。Worker 对非 loopback 请求返回 403，`run-local.mjs` 也拒绝覆盖 `--host`、`--ip` 或启用 `--remote`。**这些措施防止误把本地写接口作为公共服务发布，不是用户认证，也不保证反向代理下的访问安全。** 不要通过隧道或代理暴露此服务；团队共同写入需要先实现真实登录、成员权限和数据隔离，再单独设计部署。

## 直接复现 V4 模拟

无需安装机器学习库、无需 API Key、无需联网：

```bash
npm run data:sync
python scripts/replay-v4.py
```

脚本执行前向和历史开发两条冻结模拟，比较全部 `day`、`backtest`、`config`、`inputDigest` 和 `forecastGeneratedAt`。新的执行时间允许变化；预测生成时间、配置和数值结果必须与原件一致。输出写入忽略的 `.local-runtime/v4-replay/`。

逐条命令也保留：

```bash
python research/trading_strategy.py --data public/data/forecast-lab/v4/embedded-data.json --date 2026-10-31 --strategy normal --k 0.5 --fee-per-mwh 1 --output .local-runtime/forward-replay.json
python research/trading_strategy.py --data public/data/forecast-lab/v4/holdout-input.json --strategy normal --k 0.5 --fee-per-mwh 1 --output .local-runtime/development-replay.json
```

固定每模拟成交 MWh 扣 1 美元只是研究情景，不代表完整 CAISO 结算。模拟程序不提交市场报价。

## 继续研究时的输入与约束

只有需要运行研究测试或新实验时，才创建 Python 虚拟环境并安装 `research/requirements.txt`。环境初始化不自动重训：

```bash
python -m venv .venv
# 激活虚拟环境后：
python -m pip install -r research/requirements.txt
python research/test_current_data_pipeline.py
```

新实验使用新输出目录和明确协议。训练默认只用 D−2 及之前的完整实际日；不能改写原预测时间，不能将已看过的历史开发窗重新称为未见测试。过去的目标日只能显式使用 `--evaluation-only` 重建评估。V4 的现有输入、报告和 ZIP 不覆盖。

公开采集工具位于 `research/current_data_acquisition/`。旧扩历史脚本需要显式指定已启动的本地工作台，例如 `python research/fetch_extended_history.py --origin http://127.0.0.1:5173`；原私有网址与凭据机制已移除。来源返回 401/403 时停止，不改变网络身份、降级协议或绕过访问限制。

## API 状态及未来扩展

保留 3 组价格、13 组 Today’s Outlook、11 组 OASIS 基本面接口实现；接口数量不等于任意日期都有数据。公开服务可能有发布延迟、限流或访问失败，页面需保留真实状态和获取时间。当前没有配置 GridStatus 密钥，不应宣称其托管数据已连通；如用户自行配置，只放本地 `.dev.vars`，不提交密钥，额度及再发布范围以该账户授权为准。

OASIS 的 FMM 小时值要求完整 4 个 15 分钟区间，RTD 要求完整 12 个 5 分钟区间。交易日使用 `America/Los_Angeles`，唯一键使用 UTC，保留 23/25 小时日、真零和负值；缺失不能补零。未来扩展应复用既有数据契约，补充可追溯来源、时间和质量状态。

技术运行依据：[Vinext 官方 README](https://github.com/cloudflare/vinext/blob/main/README.md)、[Cloudflare Vite Environments](https://developers.cloudflare.com/workers/vite-plugin/reference/vite-environments/)。依赖沿用本次验证的锁定版本，未为迁移升级算法或框架。
