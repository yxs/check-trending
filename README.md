# Check Trending

观察美国签证 221(g) / Administrative Processing 的整体趋势，基于 Checkee.info 公开上报数据。静态前端：本地构建一份 JSON 后纯静态渲染。

不做个人 case tracking，不收集 DS-160 / 护照 / 姓名等私密信息，也不提供法律建议。

## 本地运行

```bash
npm install
npm run build   # build_web_data.py 生成 public/data/app-data.json + vite build（不联网）
npm run dev
```

## 功能

- 每日 Clear 趋势（7 日均线 + 含 Note 叠加，可缩放横向滚动）
- 顶部指标 + 长 Check 积压卡片（仍 Pending 且等待 ≥90 / ≥180 / ≥270 天）
- 筛选：签证组/细分、等待时长（7~270 天）、Note、地区、时间范围（写进 URL，可分享）
- 点某天看当天 Clear 明细；近期 7/14/30 天节奏与低潮区间

## 数据更新（手动）

2026-05 起，Cloudflare 给 Checkee 的两个端点（`main.php` 月度 listing 和 `personal_detail.php` 详情页）都加了 managed JS challenge，`curl_cffi` 一律 403——CI / launchd cron 等自动抓取全部失效。现在只能在真实浏览器里人工过一次 CF，再用同源 `fetch()` 复用会话抓数据。每月或想更新时跑一遍：

1. 浏览器（CF 已通过，Claude Code 可直接驱动）抓回**全部月度 listing** + 新 case 的 detail 页，原始 HTML 存到 `data/checkee/raw/refresh/{listings,details}/`。
2. `python scripts/refresh_from_browser.py` —— 解析、对账（listing 覆盖状态以捕捉 Pending→Clear、补新 case、保留旧 Note）、重建 `app-data.json`；无 listing 输入时拒绝执行。

跑完 `npm run dev` 刷新即见最新数据。细节见脚本顶部 docstring。

> 旧的 cron / calibrate 脚本已删除；`checkee_scraper.py` 仅保留供手动流程复用的 HTML 解析函数。若装过 launchd cron 它仍在空跑报 403，可用 `launchctl bootout gui/$(id -u)/com.user.checkee-daily-refresh` 卸载。

## 测试 / 部署

`npm test`、`npm run typecheck`、`python -m unittest tests/test_checkee_scraper.py`（CI 全跑，不抓数据）。部署用 `azure-static-web-apps.yml` 把 build 产物推到 Azure Static Web Apps——数据是 build 时打进去的静态 JSON，所以更新数据 ≠ 部署。
