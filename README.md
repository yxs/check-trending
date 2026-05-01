# Check Trending

一个面向中文用户的美国签证 221(g) / Administrative Processing 趋势观察网站。

## 项目背景

从 2025 年下半年开始，很多美国签证申请人在 221(g) / Administrative Processing 阶段等待明显变长。原本几周可以结束的 check，开始出现两个月、三个月甚至更久的情况。对正在等待的人来说，单个 case 的状态更新很有限，真正有帮助的是看到整体趋势：最近有没有集中 Clear、是否又进入低潮、不同签证类型和领馆之间是否有差异。

Check Trending 基于 Checkee.info 的公开上报数据，重点观察 `check_date` 到 `complete_date` 之间的变化，以及每天 Clear 数量的趋势。当前数据覆盖 2025-07-01 到 2026-05-01，共 1879 条 case，其中 1145 条已 Clear，716 条仍 Pending，1081 条包含用户填写的 Note。按当前口径，等待 60 天及以上的 case 有 1274 条；数据中可以看到 2026-01-21 到 2026-02-19 这类低速区间，也能看到随后 2 月下旬到 3 月出现的集中 Clear。

这个项目的目标不是追踪某一个人的 case，而是帮助大家用公开样本观察整体节奏。

当前版本是静态前端 MVP：本地读取已抓取的 Checkee.info 公开数据，展示每日 Clear 趋势、签证组筛选、等待时长筛选、Note 样本筛选和当天 case 明细。后续同一套 build 产物可以部署到 Static Web Apps。

## 本地运行

```bash
npm install
npm run build
npm run dev
```

然后打开 Vite 输出的 localhost 地址。

## 当前功能

- Clear 趋势图：按 `complete_date` 聚合每日 Clear 数量。
- 签证组：B 签、工作签 H/L/O、学生/学者 F/J。
- 工作签细分：H、L、O。
- 学生/学者细分：F、J。
- Check 深度：全部、7 天及以上、30 天及以上、60 天及以上、90 天及以上。
- Note 人群：全部、有 Note、无 Note。
- 地区筛选：全部、大陆、海外、单个领馆。
- 点击某一天可查看当天 Clear 的 case 和 Note。
- 当前状态：显示最近 7/14/30 天 Clear 数量和当前是否处于低潮。
- 主图交互：完整宽图 + 原生横向滚动，`+ / -` 调整每日像素宽度。
- 图表范围：仅展示已发生数据，不展示未来预测窗口。

## 数据口径

- 数据来源：Checkee.info 公开详情页。
- 起始日期：2025-07-01。
- 当前数据文件：`data/checkee/checkee_cases.json`。
- 构建时会生成前端使用的 `public/data/app-data.json`。

本项目不做个人 case tracking，不收集 DS-160、护照、姓名等私密信息，也不提供法律建议。

## 数据更新流程

- 自动任务：`Monthly Data Refresh` 工作流每月 UTC 19:00（每月 1 日，北京时间次日 03:00）触发。
- 主路径（按月页面驱动）：
  - 抓取从起始日期到当前月份的 `main.php?dispdate=YYYY-MM` 页面，汇总月度可见 case ID。
  - 基于这些 case ID 抓取 `personal_detail.php?casenum=...`，并更新 `data/checkee/checkee_cases.json`。
- 校验路径（每月一次低频对账）：
  - 在 monthly case ID 区间内做 detail-range 扫描（仅比对 case ID，不比对 detail 字段）。
  - 生成 `data/checkee/monthly_reconciliation_summary.json`，用于查看 monthly 列表和 range 扫描差异。
- 详情缓存优化：`raw/details/*.html` 会保留详情表格区域，自动去除导航、脚本、统计代码等无关片段。
- 自动提交：当数据有变更时，工作流会自动 commit 并 push 到 `main`。
- 手动触发：可在 GitHub Actions 页面手动触发该工作流，并可覆盖 `end_date`、`probe_count`。
