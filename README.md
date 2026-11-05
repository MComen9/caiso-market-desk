# CAISO 电力市场研究台

面向团队的 CAISO 市场研究项目：行情与供需资料、可复现的电价预测、策略模拟、公开交互网页，以及完整工作台源码。

**当前数据是已发布历史快照，不是实时行情。** V4 预测目标为 2026-10-31 PT；本次仓库迁移没有重新训练或改写预测。

**公开平台：[CAISO 电力市场研究台](https://mcomen9.github.io/caiso-market-desk/)** · **项目仓库：[MComen9/caiso-market-desk](https://github.com/MComen9/caiso-market-desk)**

## 从哪里开始

| 使用者 | 入口 |
|---|---|
| 查看平台的业务同事 | [公开只读网页](https://mcomen9.github.io/caiso-market-desk/)；也可打开[轻量数据页](https://mcomen9.github.io/caiso-market-desk/quick-view.html) |
| 下载和分析数据 | 网站下载入口、`data/published/` 和 `data/manifest.json`；下述核验时整批 ZIP 的 Release 为草稿，正式发行状态见 `docs/DEPLOYMENT_STATUS.json` |
| 研究预测和模拟 | `apps/workbench/research/`；最新 V4 说明见 `data/published/forecast-lab/v4/README.md` |
| 修改公开网页 | `apps/viewer/` |
| 扩展 API、数据库和完整工作台 | `apps/workbench/` |
| 使用 Codex 继续开发 | 先读 `AGENTS.md` 和 `docs/CODEX_HANDOFF.md` |

## 本地启动

需要 Node.js 22.13+（建议 24）和 Python 3.10+。只浏览网页及复现冻结模拟，不需要 API Key 或机器学习依赖。

```bash
npm run setup
npm run build
npm run verify
npm run dev
```

命令从本仓库根目录执行。开发服务的实际地址由终端输出；不要把本地地址当团队公网地址。
若要运行完整工作台，先读 [`apps/workbench/README.md`](apps/workbench/README.md)。
完整工作台默认只用于本地开发，其 API 和数据库没有随 Pages 公开。

## 目录与扩展职责

| 目录 | 职责 | 扩展方式 |
|---|---|---|
| `apps/viewer/` | 公开只读 React 前端、静态网页构建 | 新视图复用统一路径处理、数据状态和页面导航 |
| `apps/workbench/` | 完整前后端、数据适配器、存储、研究代码 | 在已有接口和数据契约上扩展；生产部署前配置真实身份认证 |
| `apps/workbench/research/` | V1–V4 算法、模拟运行器、审计和历史输出 | 新实验使用新版本，保留旧预测和原始发布时间 |
| `data/published/` | 221 项公开数据、报告和研究附件 | 冻结数据按版本更新；保持原始字节 |
| `data/downloads/` | 可离线使用的已发布附件 | 作为在线查看的补充 |
| `docs/` | 架构、业务口径、团队协作、Codex 交接 | 决策变化应同步更新说明 |
| `scripts/` | 数据校验、模拟复现、环境准备、打包与发布 | 不默认抓数、重训或更改历史结果 |
| `.github/` | 质量检查、Pages 发布和协作模板 | 合并先检查；发布动作有明确入口 |

## 当前 V4 研究基线

- 价格历史：2025-10-29—2026-10-29 PT，366 天、26,352 个节点小时。
- 枢纽：NP15、SP15、ZP26；前向预测共 72 个节点小时。
- 日前价格：`ridge_all`；价差：14 日同小时中位数收缩 50%；FMM = DA + 价差。
- 模型版本：`caiso-current-data-4.0.0+99bd6a8751fe`。
- 预测真实生成时间：2026-10-30T08:34:02.166Z。
- 开发评估窗口：2026-10-02—2026-10-29 PT，2,016 个节点小时。

| 指标 | 当前模型 | 预先声明的基线 |
|---|---:|---:|
| DA MAE，USD/MWh | 10.22450 | 11.82574 |
| FMM−DA MAE，USD/MWh | 9.18872 | 9.42685 |
| 价差方向准确率 | 57.84% | 负价差占比的事后参考为 55.85% |
| 名义 80% 区间覆盖：DA / 价差 | 74.55% / 68.65% | 名义目标 80% |

这是已见历史的开发比较，不是新的独立测试。当前结果不证明稳定交易优势。
未来实际价格保持 `null`。固定 $1/MWh 费用情景的开发模拟损益为 $397.010311；该费用是假设值，模拟不等于完整 CAISO 结算。
完整证据见 [`report.json`](data/published/forecast-lab/v4/report.json) 和 [`README.md`](data/published/forecast-lab/v4/README.md)。

## 数据与复现

```bash
# 校验全部公开数据与 72 条预测
python3 scripts/verify-data.py
# 使用维护版 Python 运行器，逐字段对照冻结的前向与历史模拟
python3 scripts/verify-v4.py
# 生成源码交接包、数据包和已构建网站包
python3 scripts/package-release.py
```

原始 V1/V2/V3 说明描述各自历史阶段；V4 为当前研究基线。
无法取得的其他资料保留为参考限制，本轮工作不以采购或补齐这些资料为前提。

## GitHub 发布

- `Quality checks`：主分支提交与 PR 运行构建、类型/路径检查、数据校验和冻结模拟复现。
- `Publish research platform`：发布 Release 或从 Actions 手动运行时，构建并发布 Pages。
- Pages 的构建源已配置为 **GitHub Actions**，站点已部署。
- 发布目录仅为 `apps/viewer/dist`，不会把工作台写 API 或数据库暴露到公网。
- 公开访问、下载和 Codex 环境的真实完成状态见 [`docs/DEPLOYMENT_STATUS.json`](docs/DEPLOYMENT_STATUS.json)。

已验证代码基线为 [`20476ca855a106f81d24b3087203d7aa714ba66c`](https://github.com/MComen9/caiso-market-desk/commit/20476ca855a106f81d24b3087203d7aa714ba66c)，共 551 个文件；该 SHA 表示首次上线核验所用的代码基线，不是后续状态文档提交的自引用版本。[质量检查](https://github.com/MComen9/caiso-market-desk/actions/runs/41966590699)和 [Pages 发布](https://github.com/MComen9/caiso-market-desk/actions/runs/41966708144)均成功。

2026-11-05 12:17:49（北京时间）的匿名核验中，首页、静态资源、轻量页、站点清单及 V4 CSV/JSON/复现包共 8 项请求全部返回 HTTP 200，字节 SHA-256 与本地发行内容一致；预测 CSV 为 72 行。核验时 `v2026.11.05` Release 为已附 3 个 ZIP 的草稿（`draft_prepared`），尚未公开发布。这是该次核验的状态快照；正式发布后会继续更新主分支记录。

本次迁移默认延续公开分享范围。未来若需要仅团队可见、多人在线运行预测或保存实验，需要配置应用登录与后端权限。

## 团队与 Codex

架构见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，协作约定见 [`docs/TEAM_WORKFLOW.md`](docs/TEAM_WORKFLOW.md)。
Codex 环境准备命令为 `bash scripts/codex-setup.sh`；详细接手任务和冻结基线见 [`docs/CODEX_HANDOFF.md`](docs/CODEX_HANDOFF.md)。

源码和数据可以成为 Codex 的项目上下文；原 ChatGPT 对话不会仅因仓库发布而自动转成一个已验证的 Codex 云环境。

当前 Codex 接手文件和本地准备验证已完成；该项目的 Codex Cloud 环境尚未创建或发布，首任务尚未验证。当前可控云浏览器中的 ChatGPT 尚未登录，需要完成登录后继续环境配置。

## 来源与使用范围

CAISO 官方数据与文档的来源链接保留在对应文件中，第三方材料保留各自权利和许可说明。
本仓库没有替第三方材料授予统一开源许可；项目原创代码的许可策略由项目所有者决定。
这是研究与模拟平台，不向市场提交真实交易。
