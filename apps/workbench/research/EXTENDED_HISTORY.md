> GitHub 迁移说明：本文件的历史数据结果保持原口径。新版脚本不再访问原托管工作台；先启动本地工作台，采集命令需显式传入 `--origin http://127.0.0.1:5173`。`--assemble-only` 不需服务端或凭据。

# 扩展 OASIS 价格历史

`fetch_extended_history.py` 将原有 Sep3–Oct28 的 56 日价格归档向前扩充，目标为 May2–Oct28 共 180 日、三个枢纽的完整 DA / FMM 小时配对。原始 `data/strategy-history.json` 与 v1 预测产物保持不变。

## 数据口径

- 上游为现有平台 `/api/prices`，该服务调用官方 OASIS 报表。单次最多 7 个 PT 交易日，三个枢纽合并请求；DAM 和 FMM 串行查询，请求起点至少间隔 8 秒。
- 原归档的全部记录直接保留。新增数据由最近缺失周开始向过去查询，成功的原始响应存入本地缓存，便于中断后继续。
- 以 `node + UTC start` 为唯一小时键。只接受一个有效 60 分钟 DA 区间和四个有效、互不重复的 15 分钟 FMM 区间。FMM 按四个区间简单平均，缺少任何一个则该小时不完整；不使用部分均值，不插值。
- 时间转换采用 `America/Los_Angeles`；UTC 枚举自然保留夏令时切换日 23 / 25 小时。零价和负价保留。
- 每完成一个窗口后审查完整性，再原子更新连续完整的历史后缀；有缺口时不会将更早的孤立窗口伪装成完整连续历史。实际开始日期、覆盖天数和失败窗口见审查文件。
- 归一化与平台 TypeScript `analytics.ts` 对原有七个周档案共 3,528 条小时记录逐条精确相等。五项合成测试覆盖时间、缺失、重复、零负价边界；测试数据不用于市场模型表现。

## 输出

- `data/strategy-history-expanded.json`：当前取得且通过完整性检查的连续价格归档。
- `research/extended-history-audit.json`：目标与实际覆盖、窗口状态、响应摘要、来源、原始归档摘要。
- `.sites-runtime/extended-history/`：请求级原始响应缓存，不包含凭据。

历史数据为当前取得的版本，可能包含事后价格修订。新增历史覆盖不能把已经看过的评价期重新变成独立未见测试集；后续实验应说明开发评价与前向检验的区别。

## 运行

```bash
python research/test_extended_history.py
python research/fetch_extended_history.py --origin http://127.0.0.1:5173
```

获取脚本仅连接 `--origin` 显式指定的 loopback 本地工作台，不读取访问凭据，并拒绝重定向。若要直接取官方数据，使用 `current_data_acquisition/` 中的公开采集脚本。用户无需联网或凭据即可使用冻结归档复算。

仅从已保存响应重建归档，不发起请求：

```bash
python research/fetch_extended_history.py --assemble-only
```

`--max-windows N` 可限制一次运行的周窗口数量，后续再次运行会复用成功缓存。时间范围变化时必须遵循新实验协议；此脚本不会更新原 v1 输入或既有模型结果。
