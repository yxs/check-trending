#!/usr/bin/env python3
"""Sync the dashboard canonical (data/checkee/checkee_cases.json) from the
browser-harvested monthly listings (_harvest_*.json), for the dashboard window
(check_date >= 2025-07-01). Catches Pending->Clear flips, adds new cases, and
refreshes Notes from the listing title attribute. Then rebuilds app-data.json.

The dashboard keeps its 2025-07 start; the 2017-> historical notes live only in
the separate search corpus (public/data/notes.json).
"""
import json, glob, subprocess, sys
from datetime import date, datetime, timezone
from pathlib import Path

REPO = Path('.')
DATA = REPO / 'data' / 'checkee'
CANON = DATA / 'checkee_cases.json'
SUMMARY = DATA / 'crawl_summary.json'
START = '2025-07-01'
BASE = 'https://www.checkee.info'

def to_int(v):
    try: return int(v)
    except (TypeError, ValueError): return None

# harvest -> {cn: record} for cd >= START (prefer longer note on dup)
hv = {}
for f in sorted(glob.glob('_harvest_*.json')):
    for r in json.load(open(f))['records']:
        if (r.get('cd') or '') < START:
            continue
        cn = r['cn']
        if cn in hv and len((r.get('note') or '')) <= len(hv[cn].get('note') or ''):
            continue
        hv[cn] = r

canon = json.loads(CANON.read_text(encoding='utf-8'))
by_cn = {str(r['case_number']): r for r in canon}

flips = new = note_updates = 0
for cn, r in hv.items():
    cmp_ = r.get('cmp') or ''
    cmp_ = None if cmp_ in ('', '0000-00-00') else cmp_
    note = (r.get('note') or '').strip()
    prev = by_cn.get(cn)
    detail = dict(prev['detail']) if (prev and prev.get('detail')) else {'case_number': cn}
    if note:
        if (detail.get('Note') or '').strip() != note:
            note_updates += 1
        detail['Note'] = note
    # keep detail consistent on the fields the listing authoritatively knows
    detail['Status'] = r.get('st', detail.get('Status',''))
    rec = {
        'case_number': cn,
        'display_id': r.get('id',''),
        'visa_type': r.get('vt',''),
        'visa_entry': r.get('ve',''),
        'consulate': r.get('con',''),
        'major': r.get('maj',''),
        'status': r.get('st',''),
        'check_date': r.get('cd',''),
        'complete_date': cmp_,
        'waiting_days': to_int(r.get('wd')),
        'detail_url': f"{BASE}/personal_detail.php?casenum={cn}",
        'month': (r.get('cd','') or '')[:7],
        'source_url': f"{BASE}/main.php?dispdate={(r.get('cd','') or '')[:7]}",
        'detail': detail,
    }
    if prev is None:
        new += 1
    elif prev.get('status') != rec['status']:
        flips += 1
    by_cn[cn] = rec

ordered = sorted(by_cn.values(), key=lambda r: (r.get('check_date',''), str(r.get('case_number',''))))
# end_date = max observed check/complete date, but >= today
dts = []
for r in ordered:
    for k in ('check_date','complete_date'):
        v = r.get(k)
        if isinstance(v,str) and v and v != '0000-00-00': dts.append(v)
end_date = max(dts + [date.today().isoformat()])
note_count = sum(1 for r in ordered if (r.get('detail') or {}).get('Note','').strip())
summary = {
    'case_count': len(ordered),
    'detail_count': sum(1 for r in ordered if r.get('detail')),
    'end_date': end_date,
    'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'note_count': note_count,
    'start_date': START,
}
CANON.write_text(json.dumps(ordered, ensure_ascii=False, indent=2), encoding='utf-8')
SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"canonical: {len(ordered)} cases (+{new} new, {flips} status flips, {note_updates} note updates, {note_count} with-note, through {end_date})")
subprocess.run([sys.executable, str(REPO/'scripts'/'build_web_data.py')], cwd=str(REPO), check=True)
