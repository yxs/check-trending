# 统一起始窗口到 2014-01-01 + 全量重抓数据

日期: 2026-07-21

## 目标

1. 主页面与搜索页的**覆盖窗口统一到 2014-01-01 起**(当前主页 2021、搜索页 2017,不同步)。
2. 全部数据重抓、同步到今天(2026-07-21)。

## 根因

两个 build 脚本各自独立算起始日,没有共享的窗口定义:

| 页面 | 数据文件 | 起始日来源 | 现值 | 规模 |
|---|---|---|---|---|
| 主页面 | `public/data/app-data.json` | `sync_dashboard_from_harvest.py` 硬编码 `START='2021-01-01'` | 2021-01-01 | 13,314 案例 / 8,639 note |
| 搜索页 | `public/data/notes.json` | `build_notes_corpus.py` 取数据 `min(date)` | 2017-01-03 | 17,478 note |

且真实数据底线是 2017——本地 `_harvest_2017…2026.json` 从 2017-01-03 起,无 2014–2016。"改到 2014" 必须真去抓 2014–2016 的数据,不是改标签。

**旧 bug 教训**:此前想让两页日期不同,给 notes 加了截断过滤,把搜索语料砍小了(已由 `650bb54 unify` 修复,现无过滤)。本次绝不重新引入任何会减少 note 的过滤。

## 已验证的前提

用隐身浏览器实测 checkee.info:

- **2014 年数据存在**,note 照样在列表页 `title` 属性里,格式与 2017+ 完全一致。
  - `2014-01`:117 行 / 53 note,check 从 2014-01-02 起
  - `2014-06`:418 行 / 182 note
- checkee.info 现在对**每个**请求都上 Cloudflare 挑战(当前月 curl 也 403),抓取必须走隐身浏览器 `patchright`(已装在 `.venv`),不能用 curl。

## 决策(已确认)

- 起始窗口:**2014-01-01**。
- 同步范围:**全量重抓 2014-01 → 2026-07**(约 151 个月),所有 `_harvest_*.json` 重新生成为今天的统一快照,不与旧数据合并。捕捉全部旧案的状态翻转(Pending→Clear/Reject)。

## 设计

### Part 1 — 全量重抓(生成本地 `_harvest_*.json`,gitignore、不进库)

新增可复用脚本 **`scripts/harvest_listings.py`**(committed,让抓取可重复、有文档):

- 复用现成件:`check_trending.cf_fetcher.BrowserFetcher`(headed patchright,一个会话、挑战只解一次)+ `check_trending.checkee_scraper.parse_month_page`(已解析列表行,含 `title`→note)。
- 参数:`--start-month 2014-01 --end-month 2026-07`(默认 end = 当月)。
- 逐月 `GET main.php?dispdate=YYYY-MM` → 解析 → 转成短键 harvest 记录 `{cn,id,vt,ve,con,maj,st,cd,cmp,wd,note,img,month}`。
- 按年组装 `{year, summary, recordCount, records}`,写 `_harvest_YYYY.json`。
  - **下游只消费 `records`**;`summary`/`img` 为尽力而为(不影响 build)。
- 稳健性:
  - 月间礼貌延时;挑战/`blocked` 时重试。
  - **每年抓完才落盘该年文件**(可续跑,失败不半途污染)。
  - 开跑前把现有 `_harvest_*.json` 备份到 scratchpad,验证新文件计数不低于旧值后再采用。

### Part 2 — 把窗口统一到 2014-01-01(修根因:单一来源)

新增共享常量,消除"两处各算日期"的根因:

- 新 `scripts/window.py`:`WINDOW_START = '2014-01-01'`。
- `sync_dashboard_from_harvest.py`:`START` 改为 `from window import WINDOW_START`(2021→2014)。
- `build_web_data.py`:不变(它信任 `crawl_summary.json` 的 start/end)。
- `build_notes_corpus.py`:展示用的 `start_date`/`end_date` **改为读 `crawl_summary.json`**(与主页同一来源);若缺失才回退到自算 min/max。**不按日期砍任何 note**(全部 2014+ 数据保留)。
  - 效果:两页显示同一个 "2014-01-01 至 <同一结束日>",且今后不会再各自漂移。

UI 文案(只改年份数字,保留原话):

- `src/App.tsx:372`「搜 2017 年至今的 Case Note」→「搜 2014 年至今的 Case Note」
- `src/NotesPage.tsx:133`「搜索 2017 年至今所有带 Note 的 Checkee 样本。」→「…2014 年至今…」
- `README.md`「2017 年至今…(1.7 万+ )」→ 年份改 2014、计数按重建结果更新。

### Part 3 — 重建 + 校验

1. `python3 scripts/sync_dashboard_from_harvest.py`(→ canonical + crawl_summary,内部再跑 build_web_data → app-data.json)
2. `python3 scripts/build_notes_corpus.py`(→ notes.json)
3. `npm run build`(vite;会再跑一遍 build_web_data + build_notes_corpus)
4. `npm test` + `npm run typecheck`

校验清单:

- [ ] app-data.json 与 notes.json 的 `start_date` 都是 `2014-01-01`,`end_date` 一致。
- [ ] 两页 UI 顶部都显示「2014-01-01 至 <同一日期>」。
- [ ] 案例数 / note 数均**上涨**(搜索页没缩水);记录重建前后数字对比。
- [ ] 散点(0–180d Clear)与趋势图覆盖到 2014。
- [ ] 浏览器实测两页(playwright)日期与数据量正确。

## 要接受的代价

主页 payload 变大:app-data.json 从 ~13k 案例(~3.5MB)涨到约 35–38k(估 ~9–10MB 原始;gzip 后约 ~2–2.5MB)。build 后**实测记录**;若手机端明显变卡,再单独优化(本次 out of scope)。与 mobile-first 有张力,但用户明确要 2014 全量数据。

## 改动文件

- 新增 `scripts/harvest_listings.py`(抓取器)
- 新增 `scripts/window.py`(`WINDOW_START` 常量)
- 改 `scripts/sync_dashboard_from_harvest.py`(用 `WINDOW_START`)
- 改 `scripts/build_notes_corpus.py`(start/end 读 crawl_summary;不砍 note)
- 改 `src/App.tsx`、`src/NotesPage.tsx`、`README.md`(文案年份)
- 重生成(数据产物):`_harvest_*.json`(本地)、`data/checkee/checkee_cases.json`、`crawl_summary.json`、`public/data/{app-data,notes,case-notes}.json`

## As-built deltas (2026-07-21)

两处偏离原计划,均因现实约束:

1. **抓取方式**:原计划的 `scripts/harvest_listings.py`(patchright)**不可用**——bundled chromium 解不开 Cloudflare 挑战(180s 超时,重试循环反复弹挑战)。改用真实浏览器(Playwright MCP)解一次挑战,再用页内 `fetch(...,{credentials:'include'})` 借 `cf_clearance` cookie 一次会话抓全部 151 个月。该脚本已删除;方法记入 memory。
2. **单一来源**:未新建 `scripts/window.py`。`START` 仍在 `sync_dashboard_from_harvest.py`,经 `crawl_summary.json` 传给两页(build_notes 读它)——数据层已是单一来源,无需额外模块。

结果:主页/搜索页均 **2014-01-01 至 2026-07-21**;37,163 案例 / 21,522 note(搜索语料 17,478→21,522,未缩水);68 次状态翻转;app-data.json 9.95MB raw / **0.55MB gzip**。测试 42 JS + 32 py 全绿,typecheck 通过。

## Out of scope

- payload 体积优化(懒加载/分片)。
- note 语义重分类(与散点无关,已在 memory 中 deferred)。
- 抓取自动化/定时(仍是手动跑脚本刷新)。
