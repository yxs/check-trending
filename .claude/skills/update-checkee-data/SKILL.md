---
name: update-checkee-data
description: 刷新 Check Trending 的 checkee.info 数据到最新——重抓最近窗口(当年+过去两年),重建 dashboard 与 note 语料并校验。当用户要求"更新/同步数据到最新"时使用。
---

# 更新 Check Trending 数据

把站点数据刷新到最新:新案例、状态翻转(Pending→Clear/Reject)、新增/加长的 note。

## 刷新窗口(约定)

只重抓**当前自然年 + 过去两年**(例:2026 年跑 → 2024、2025、2026)。老年份是冻结的——某月的案例列表成员不再变(整月重抓和旧快照逐行一致),只有最近一两年的 Pending 会翻转、会加 note。极少数"很老的 Pending 多年后才出签"会漏,但 >1 年的 Pending 本就从积压/时长统计里排除。想彻底核对时,把窗口改成 2014-01 → 当前月做一次全量重抓即可。

## 为什么必须用真实浏览器

checkee.info 现在对**每个** `main.php` 请求都上 Cloudflare 挑战(纯 curl → 403,连当前月也是;仓库里 `check_trending/cf_fetcher.py` 的 patchright fetcher 解不开,会 180s 超时并反复弹挑战)。唯一可靠方式:真实浏览器(Playwright MCP)先解一次挑战,之后用**页内 `fetch`** 借 `cf_clearance` cookie 抓其余所有月份(同源请求返回 200,不再挑战)。

## Step 1 — 抓取(浏览器,一次会话)

1. `browser_navigate` 到 `https://www.checkee.info/main.php?dispdate=2026-01`(任意近期月),再 `browser_wait_for` 等 `Just a moment` 消失(title 变 `Check Reporter`,约 25s)。
2. 对窗口内每一年跑一次下面的 `browser_evaluate`,并带 `filename: "harvest_<YEAR>.json"` 把结果存盘。每次改 `YEAR`;**当前年**把 `MONTHS` 改成到当前月为止(如 7 月就 `length: 7`),往年用 `12`。
3. 把每个 `harvest_YYYY.json` 移成仓库根目录的 `_harvest_YYYY.json`(gitignored,构建输入):
   ```bash
   for y in 2024 2025 2026; do mv -f harvest_$y.json _harvest_$y.json; done
   ```

抓取 JS(逐月 in-page fetch → 短键 `_harvest` schema;列位见文末):

```js
async () => {
  const YEAR = 2026;          // 改这里
  const MONTHS = 7;           // 当前年=当前月份数;往年=12
  const cellText = td => (td.textContent || '').replace(/\s+/g, ' ').trim();
  function extractRows(doc, month) {
    const out = [];
    for (const tr of doc.querySelectorAll('tr')) {
      const tds = [...tr.querySelectorAll('td')];
      if (tds.length < 11) continue;
      if (cellText(tds[0]).toLowerCase() !== 'update') continue;
      let cn = null;
      for (const a of tr.querySelectorAll('a[href]')) {
        const m = a.getAttribute('href').match(/casenum=(\d+)/);
        if (m) { cn = m[1]; break; }
      }
      if (!cn) continue;
      let note = '';
      for (const a of tds[10].querySelectorAll('[title]')) {
        const t = (a.getAttribute('title') || '').trim();
        if (t) { note = t; break; }
      }
      const cmp = cellText(tds[8]);
      out.push({ cn, id: cellText(tds[1]), vt: cellText(tds[2]), ve: cellText(tds[3]),
        con: cellText(tds[4]), maj: cellText(tds[5]), st: cellText(tds[6]),
        cd: cellText(tds[7]), cmp: cmp === '0000-00-00' ? '' : cmp,
        wd: cellText(tds[9]), note, img: !!note, month });
    }
    return out;
  }
  const months = Array.from({ length: MONTHS }, (_, i) => `${YEAR}-${String(i + 1).padStart(2, '0')}`);
  const records = [], summary = [];
  for (const month of months) {
    let rows = [], status = 0, blocked = false;
    try {
      const res = await fetch('/main.php?dispdate=' + month, { credentials: 'include' });
      status = res.status;
      const html = await res.text();
      blocked = /just a moment/i.test(html);
      if (!blocked) rows = extractRows(new DOMParser().parseFromString(html, 'text/html'), month);
    } catch (e) { status = -1; }
    records.push(...rows);
    const wn = rows.filter(r => r.note).length;
    summary.push({ month, http: status, rows: rows.length, withNote: wn, withImg: wn, gap: 0, blocked });
    await new Promise(f => setTimeout(f, 200));
  }
  return { year: YEAR, summary, recordCount: records.length, records };
}
```

若中途出现 `blocked:true`(cf_clearance 过期),重新 `browser_navigate` 任一月、等挑战消失,再继续剩余年份。

## Step 2 — 重建

```bash
python3 scripts/sync_dashboard_from_harvest.py   # → canonical + crawl_summary + app-data.json(START=2014-01-01)
python3 scripts/build_notes_corpus.py            # → notes.json(起止日读 crawl_summary,与主页同源)
npm run build                                    # 会再跑一遍 build_web_data + build_notes_corpus + vite
```

`sync_dashboard_from_harvest.py` 会 merge 进 canonical(保留掉出列表的旧案),并打印 `+N new / M status flips / K note updates`。

## Step 3 — 校验

- 每个新 `_harvest_YYYY.json` 的 `summary` 无 `blocked:true` 或 `http!=200` 的月份。
- `app-data.json` 与 `notes.json` 的 `start_date` 都是 `2014-01-01`,`end_date` 一致。
- 案例数 / note 数 **≥ 上次**(不缩水)。
- `npm test` + `npm run typecheck` 通过。
- 浏览器抽查:主页与 `/notes` 顶部日期一致;主页 Case 明细滚动到位后 note 正常渲染(手机宽度下是卡片、note 全宽可见)。

## 列表列位(main.php 行,`<td>` 顺序)

`[0]Update  [1]id  [2]visa_type  [3]visa_entry  [4]consulate  [5]major  [6]status  [7]check_date  [8]complete_date  [9]waiting_days  [10]note(在该行链接的 title 属性里)`

数据不进 git 的是 `_harvest_*.json`(gitignored);进 git 的产物是 `data/checkee/{checkee_cases,crawl_summary}.json` 和 `public/data/{app-data,notes,case-notes}.json`。相关背景见项目 memory `project_note_search_corpus` / `project_checkee_detail_challenge`。
