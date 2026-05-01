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

### 主路径：`Daily Data Refresh`（CI 自动）

- 调度：每天 03:00 北京时间（cron `0 19 * * *`）。
- 模式：`--source detail-range`，扫描 case_number 区间 `[842700, max_known + probe_count]`。
- 行为：
  - **Frontier probe**（`case_number > max_known`）：上探 `probe_count`（默认 40）个号段，发现新 case。Checkee 的 case_number 严格自增，新 case 必落在这段。
  - **Pending refresh**：cache 命中且 status ∈ {`Clear`, `Reject`} 的 case 跳过；否则 force-fetch detail，捕捉 Pending → Clear 的状态翻转、Note 增删。
  - **Merge**：本轮 records 按 `case_number` merge 进 `data/checkee/checkee_cases.json`，不会因为 fetch 失败把已收录的 case 从 canonical 丢出去。
- 不依赖 Cloudflare：detail 页 (`personal_detail.php`) 未启用 challenge，纯 `urllib`，无需 patchright / xvfb / chromium。CI 跑 ~6 min 完成。

### 次要路径：月度对账（本地手动跑）

`main.php?dispdate=YYYY-MM` 月度页面被 Cloudflare managed JS challenge 保护，GitHub Actions 的 datacenter IP 上无法稳定通过（实测 patchright + xvfb + bundled stealth chromium 都被拦）。所以这条路径**只在本地（residential IP）手动跑**，需要时执行：

```bash
pip install patchright
patchright install chromium --no-shell
python -m check_trending.checkee_scraper \
  --mode reconcile \
  --start-date 2025-07-01 \
  --end-date "$(date -u +%F)" \
  --monthly-fetcher browser \
  --probe-count 40
```

会更新 `data/checkee/monthly_case_ids.json` manifest、写一份 `data/checkee/reports/reconciliation/YYYY-MM.json` 对账报告，并把 `brute_force_only`（detail 页存在但月度页面没列出）的 case 自动 merge 进 canonical。频率建议 1 个月 1 次。

### 数据文件组织

- `data/checkee/checkee_cases.json` — 所有 case 的 canonical 数据，前端构建源。每天 daily 主路径更新。
- `data/checkee/monthly_case_ids.json` — 每月的 case ID manifest（来自 `main.php` 月度页解析）。仅在本地手动跑次要路径时刷新。
- `data/checkee/raw/details/*.html` — detail 页面缓存，已 trim 到详情表格片段。
- `data/checkee/reports/reconciliation/YYYY-MM.json` — 月度对账报告归档（仅在跑次要路径时生成）。
- `data/checkee/crawl_summary.json` — canonical 数据集 summary，被 `scripts/build_web_data.py` 校验。

### 自动提交

- 主路径在数据有变化时自动 `commit` + `push` 到 `main`。
- 主路径支持 `workflow_dispatch` 手动触发，可覆盖 `end_date`、`probe_count`。
