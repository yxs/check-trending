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

数据流分两条互不依赖的路径：CI 自动跑的 daily refresh，和本地手动跑的 monthly calibration。两条都只动 detail 页 / 月度 listing 这一类公开数据，不抓任何敏感信息。

### Path 1：Daily Refresh（CI 自动）

`.github/workflows/daily-data-refresh.yml`

- **调度**：每周二、四、六 02:37 北京时间（cron `37 18 * * 1,3,5`）+ 入口随机延迟 0-30 min。
- **跳过逻辑**：如果 `crawl_summary.json` 显示数据 < 36 小时，scheduled 触发会自动 skip（手动 dispatch 不受影响）。
- **抓取范围**：完全只抓 `personal_detail.php`，**不碰 main.php**（无 Cloudflare 接触面）。每次 run 做两件事：
  - **Pending bucket refresh**：把 canonical 里所有 non-terminal case 按 `case_number % 3` 分成 3 组，每个调度日刷一组（Tue→bucket 0，Thu→bucket 1，Sat→bucket 2）。每个 Pending case 一周被刷一次。
  - **Frontier probe**：`max_known+1` 起向上探 `probe_count`（默认 80）个号段，发现新提交的 case。case_number 严格自增，所以新 case 必落在这段。
- **politeness**：UA 池轮换、3-7s delay + jitter、每 25 fetch 一次 15-45s 长停、shuffle 顺序、连续 5 次 fetch 失败触发 circuit breaker。
- **失败处理**：fetch 失败**不会** silent fallback to cache（这是过去 bug 的根源）——失败计入 `failures`，单 run failure_rate > 20% 直接退出非零。circuit breaker 触发也是非零退出。
- **观测**：每次 run 写 `data/checkee/last_run_summary.json`，并 surface 到 GitHub Actions step summary（attempts / successes / failures / new cases / pending status changes）。

### Path 2：Monthly Calibration（本地手动跑）

`scripts/calibrate.sh`

`main.php?dispdate=YYYY-MM` 被 Cloudflare managed JS challenge 保护——detail 页面**没有** JS challenge，但月度 listing 有。所以校准只在本地用 patchright + headed Chrome 跑。当你想确认 canonical 数据没有遗漏时执行：

```bash
bash scripts/calibrate.sh
```

会做：

1. 启动 headed Chrome（你能看见 Cloudflare 解开）。
2. 决定要抓哪些月份：
   - 当月、上月：永远抓（hard rule，不依赖今天几号）。
   - 更早的月份：仅当 `monthly_calibration_log.json` 里没记录过时抓。
3. 抓回的每月 listing 解析后更新 `monthly_case_ids.json`，并把这次校准日期写进 `monthly_calibration_log.json`。
4. diff 月度 listing vs canonical：listing 里有但 canonical 没有的 case，用 urllib 抓 detail 补进 canonical。
5. 写一份 `data/checkee/reports/reconciliation/YYYY-MM-DD.json` 报告（per-run 归档，便于审计历史）。

不刷新已有 Pending 的状态——那是 Path 1 的职责。Path 2 只负责 case ID 的发现与对账。

### 数据文件组织

- `data/checkee/checkee_cases.json` — canonical 数据集，前端构建源。Path 1 与 Path 2 都会写。
- `data/checkee/monthly_case_ids.json` — 每月的 case ID manifest（来自 `main.php` 解析）。仅 Path 2 写。
- `data/checkee/monthly_calibration_log.json` — `{month: 上次校准日期}`。仅 Path 2 写。
- `data/checkee/raw/details/*.html` — detail 页缓存，已 trim 到详情表格片段。
- `data/checkee/reports/reconciliation/YYYY-MM-DD.json` — 校准报告归档（仅 Path 2 生成）。
- `data/checkee/crawl_summary.json` — canonical 数据集元信息，被 `scripts/build_web_data.py` 校验。
- `data/checkee/last_run_summary.json` — 最近一次 scrape run 的运行统计。

### 自动提交

- Path 1 在数据有变化时自动 `commit` + `push` 到 `main`。
- Path 1 支持 `workflow_dispatch` 手动触发，可覆盖 `bucket`、`probe_count`、`end_date`。
- Path 2 完成后**不**自动 commit——你 review `git status` 满意了再自己提交。
