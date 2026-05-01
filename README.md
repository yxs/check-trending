# Check Trending

一个面向中文用户的美国签证 221(g) / Administrative Processing 趋势观察网站。

当前版本是静态前端 MVP：本地读取已抓取的 Checkee.info 公开数据，展示每日 Clear 浪潮、签证组筛选、Check 深度筛选、Note 人群筛选和当天 case 明细。后续同一套 build 产物可以部署到 Azure Static Web Apps。

## 本地运行

```bash
npm install
npm run build
npm run dev
```

然后打开 Vite 输出的 localhost 地址。

## 当前功能

- Clear 浪潮图：按 `complete_date` 聚合每日 Clear 数量。
- 签证组：B 签、工作签 H/L/O、学生/学者 F/J。
- 工作签细分：H、L、O。
- Check 深度：全部、7 天及以上、30 天及以上、60 天及以上、90 天及以上。
- Note 人群：全部、有 Note、无 Note。
- 地区筛选：全部、大陆、海外、单个领馆。
- 点击某一天可查看当天 Clear 的 case 和 Note。

## 数据口径

- 数据来源：Checkee.info 公开详情页。
- 起始日期：2025-07-01。
- 当前数据文件：`data/checkee/checkee_cases_2025-07-01_to_2026-04-29.json`。
- 构建时会生成前端使用的 `public/data/app-data.json`。

本项目不做个人 case tracking，不收集 DS-160、护照、姓名等私密信息，也不提供法律建议。
