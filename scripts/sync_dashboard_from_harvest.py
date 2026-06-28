#!/usr/bin/env python3
"""Rebuild the dashboard canonical + app-data.json from _harvest_*.json (check_date >= 2021-01-01)."""
import json, glob, subprocess, sys
from datetime import date, datetime, timezone
from pathlib import Path

REPO = Path('.')
DATA = REPO / 'data' / 'checkee'
CANON = DATA / 'checkee_cases.json'
SUMMARY = DATA / 'crawl_summary.json'
START = '2021-01-01'
BASE = 'https://www.checkee.info'
TERMINAL = {'Clear', 'Reject'}
TODAY = date.today()

def to_int(v):
    try: return int(v)
    except (TypeError, ValueError): return None

def valid_iso(value):
    try:
        return datetime.strptime(value, '%Y-%m-%d').date().year >= 2000
    except (TypeError, ValueError):
        return False

def waiting_days(status, check_date, harvested_wd):
    days = None
    if status not in TERMINAL:
        try:
            days = (TODAY - datetime.strptime(check_date, '%Y-%m-%d').date()).days
        except (TypeError, ValueError):
            days = None
    if days is None:
        days = to_int(harvested_wd)
    return days if days is not None and days >= 0 else None

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
    cmp_ = cmp_ if valid_iso(cmp_) else None
    note = (r.get('note') or '').strip()
    prev = by_cn.get(cn)
    detail = dict(prev['detail']) if (prev and prev.get('detail')) else {'case_number': cn}
    if note:
        if (detail.get('Note') or '').strip() != note:
            note_updates += 1
        detail['Note'] = note
    detail['Status'] = r.get('st', detail.get('Status', ''))
    rec = {
        'case_number': cn,
        'display_id': r.get('id', ''),
        'visa_type': r.get('vt', ''),
        'visa_entry': r.get('ve', ''),
        'consulate': r.get('con', ''),
        'major': r.get('maj', ''),
        'status': r.get('st', ''),
        'check_date': r.get('cd', ''),
        'complete_date': cmp_,
        'waiting_days': waiting_days(r.get('st', ''), r.get('cd', ''), r.get('wd')),
        'detail_url': f"{BASE}/personal_detail.php?casenum={cn}",
        'month': (r.get('cd', '') or '')[:7],
        'source_url': f"{BASE}/main.php?dispdate={(r.get('cd', '') or '')[:7]}",
        'detail': detail,
    }
    if prev is None:
        new += 1
    elif prev.get('status') != rec['status']:
        flips += 1
    by_cn[cn] = rec

ordered = sorted(by_cn.values(), key=lambda r: (r.get('check_date', ''), str(r.get('case_number', ''))))
dts = []
for r in ordered:
    for k in ('check_date', 'complete_date'):
        v = r.get(k)
        if isinstance(v, str) and v and v != '0000-00-00': dts.append(v)
end_date = max(dts + [TODAY.isoformat()])
note_count = sum(1 for r in ordered if (r.get('detail') or {}).get('Note', '').strip())
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
subprocess.run([sys.executable, str(REPO / 'scripts' / 'build_web_data.py')], cwd=str(REPO), check=True)
