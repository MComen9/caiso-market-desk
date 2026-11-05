# CAISO 只读研究平台

团队查看行情快照、供需、V1–V4 预测与验证、固定策略模拟和公开数据下载的前端。
保留现有中文交互页面；不连接原工作台的 D1、私有 API 或服务端凭据。

## 安装与开发

需要 Node.js 22.13 或更高版本。进入本目录运行：

```bash
npm ci
npm run dev
```

预览默认位于 `http://127.0.0.1:4173/`。修改组件后自动重新构建，刷新网页查看；修改共享数据后重新运行开发命令。

## 构建与预览

```bash
npm run build
npm run verify
npm run preview
```

输出目录是 `apps/viewer/dist/`。GitHub Pages 项目站点需要仓库子路径：

```bash
npm run build -- --base /caiso-market-desk/
npm run verify
npm run preview -- --base /caiso-market-desk/
```

也可通过 `PUBLIC_BASE_PATH` 指定同一个路径。使用个人主页仓库或自定义域名根路径时传 `/`。
预览的 `--base` 必须与已构建版本一致。`--host`、`--port` 可调整本地预览监听地址与端口。

## 目录职责

| 位置 | 内容 |
| --- | --- |
| `components/` | 市场、供需、数据目录、预测、模拟页面 |
| `lib/` | 图表分析、时区、数据类型、`publicUrl()` 路径处理 |
| `app/` | 页面样式 |
| `scripts/` | 完整构建、静态页生成、预览及迁移检查 |
| `../../data/published/` | 已审查的公开数据全集，构建时原样复制至 `dist/data/` |
| `../../data/downloads/` | 已归档离线页面与下载包，原样复制至 `dist/downloads/` |

`publicUrl()` 为运行时读取和下载地址添加站点基础路径，保持外链、锚点和已编码路径不变。
报告和数据目录中的原始 `/data/…` 链接在组件渲染时转换，冻结 JSON 无需被改写。
新页面引用站内绝对路径时使用此函数，不直接写 `href="/…"` 或 `fetch('/data/…')`。

## 检查

```bash
npm test
npm run check
```

`npm run check` 检查 TypeScript 和当前已构建产物，不重建或改变部署路径。
`npm test` 先检查 TypeScript，再分别构建 `/` 与 `/caiso-market-desk/`，验证：

- 快照与下载包的字节完整性；
- 首页、轻量数据页、CSV 查看页及目录下载地址；
- 逐小时行数、CSV 完整文本、报告关联文件；
- 实际本地 HTTP 页面、数据和下载响应，以及未知地址 404、写请求 405；
- 路径前缀、哈希导航与 `%2F` 编码不会被重复处理。

测试最后保留 `/caiso-market-desk/` 构建；正式发布前再以目标路径构建一次。
这些检查不声称已完成团队网络或真实浏览器视觉验收。

## 快照与更新

首页保留无需脚本的核心指标和 `quick-view.html` 入口；后者内嵌完整逐小时表、曲线和评估。
`data/forecast-lab/v4/forecast-csv.html` 根据同一批 CSV 重新生成，支持查看、复制和下载。
这个 HTML 展示包装会随部署路径变化，原始 CSV、JSON、研究结果和 ZIP 保持字节不变。

当前数据是已发布的历史研究快照，重读或重新构建不会自动抓取新数据、训练模型或更换预测。
后续增加数据版本时，先按根目录的数据发布流程更新公开材料，再构建并通过检查。
