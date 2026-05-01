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

数据更新拆成两条路径：

### 主路径：`Daily Data Refresh`

- 调度：每天 03:00 北京时间（cron `0 19 * * *`）。
- Case ID 发现：只抓"还可能新增 ID"的月份。
  - day-of-month ≤ 15：抓**当前月 + 上个月**（处理迟到上报的 buffer 窗口）。
  - day-of-month > 15：只抓**当前月**。
  - 历史月份的 case ID 列表从 `data/checkee/monthly_case_ids.json` manifest 直接读取，不再 fetch。
- Detail 更新：
  - 当前月抓到的 case → fetch detail。
  - canonical 中所有非终态（不在 `Clear` / `Reject`）的 case → 强制 fetch detail，更新 status / note / complete_date。
  - 终态 case → 不动（小概率会变，留给月度校准抽查）。
- Merge：将本轮新 records 按 `case_number` merge 进 `data/checkee/checkee_cases.json`，保留历史月份不在本轮 scope 的 case。
- Cloudflare：`main.php` 受 Cloudflare managed JS challenge 保护，在 GitHub Actions 上通过 `xvfb-run` + `patchright`（Playwright 的 stealth fork）+ 系统 Chrome 解 challenge。详情页未启用 challenge，仍走 `urllib`。

### 校准路径：`Monthly Reconciliation`

- 调度：每月 16 日 03:00 北京时间（cron `0 19 15 * *`）。这一天上一月已不在主路径 buffer 窗口内，case ID 完全 frozen，适合做 ID 级对账。
- 流程：先跑主路径（manifest + pending refresh + merge），再做 detail-range 暴力扫描——按 case_number 区间 `[min(canonical), max(canonical) + probe_count]` 逐个 fetch detail，验证哪些 case 落在日期范围内。
- 输出对账报告 `data/checkee/reports/reconciliation/YYYY-MM.json`，记录 monthly_only / brute_force_only / matched 等指标，并把 brute_force_only（月度漏列但 detail 页存在）的 case 自动 merge 进 canonical。
- 报告按月归档，永久保留，供以后排查。

### 数据文件组织

- `data/checkee/checkee_cases.json` — 所有 case 的 canonical 数据，前端构建源。
- `data/checkee/monthly_case_ids.json` — 每月的 case ID manifest，避免重复抓已 frozen 月份。
- `data/checkee/raw/details/*.html` — detail 页面缓存，已自动 trim 到详情表格区域，去掉导航、脚本、统计等无关片段。
- `data/checkee/reports/reconciliation/YYYY-MM.json` — 月度对账报告归档。
- `data/checkee/crawl_summary.json` — canonical 数据集的最新 summary（被 `scripts/build_web_data.py` 校验）。

### 自动提交

- 两个工作流都会在数据有变化时自动 `commit` + `push` 到 `main`。
- 都支持 `workflow_dispatch` 手动触发，主路径可覆盖 `end_date`，校准路径还可覆盖 `probe_count`。
