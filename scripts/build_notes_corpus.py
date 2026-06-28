#!/usr/bin/env python3
"""Consolidate _harvest_*.json (browser-harvested monthly listings) into the
note-search corpus: every case 2017→now whose listing carried a Note.

Output: public/data/notes.json  (loaded lazily by the note-search page).
Each case keeps short keys to keep the payload small (17k+ records):
  cn case_number | id display_id | vt visa_type | ve visa_entry | co consulate
  mj major | st status | cd check_date | cp complete_date(null if 0000-00-00)
  wd waiting_days(int|null) | nt note(raw, newlines preserved)
"""
import json, glob, gzip
from datetime import date, datetime, timezone

REPO = '.'
files = sorted(glob.glob('_harvest_*.json'))
by_case = {}
for f in files:
    d = json.load(open(f))
    for r in d['records']:
        note = (r.get('note') or '').strip()
        if not note:
            continue
        cn = r['cn']
        cmp_ = r.get('cmp') or ''
        cmp_ = None if cmp_ in ('', '0000-00-00') else cmp_
        try: wd = int(r.get('wd'))
        except (TypeError, ValueError): wd = None
        rec = {
            'cn': cn, 'id': r.get('id',''), 'vt': r.get('vt',''), 've': r.get('ve',''),
            'co': r.get('con',''), 'mj': r.get('maj',''), 'st': r.get('st',''),
            'cd': r.get('cd',''), 'cp': cmp_, 'wd': wd, 'nt': r.get('note','').strip(),
        }
        prev = by_case.get(cn)
        # keep the record with the longer note (notes grow over time / dup safety)
        if prev is None or len(rec['nt']) > len(prev['nt']):
            by_case[cn] = rec

cases = list(by_case.values())
cases.sort(key=lambda r: (r['cd'], r['cn']), reverse=True)
dates = [r['cd'] for r in cases if r['cd']]
payload = {
    'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'count': len(cases),
    'start_date': min(dates), 'end_date': max(dates),
    'cases': cases,
}
out = 'public/data/notes.json'
blob = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
open(out, 'w', encoding='utf-8').write(blob)

raw = len(blob.encode('utf-8'))
gz = len(gzip.compress(blob.encode('utf-8')))
notelens = sorted(len(r['nt']) for r in cases)
def pct(p): return notelens[min(len(notelens)-1, int(len(notelens)*p))]
print(f"wrote {out}")
print(f"cases: {len(cases)}  range: {payload['start_date']} .. {payload['end_date']}")
print(f"size: raw={raw/1e6:.2f} MB  gzip={gz/1e6:.2f} MB")
print(f"note length: p50={pct(.5)} p90={pct(.9)} p99={pct(.99)} max={notelens[-1]}")
# status / visa mix
from collections import Counter
print("status mix:", dict(Counter(r['st'] for r in cases).most_common(6)))
print("visa mix:", dict(Counter(r['vt'] for r in cases).most_common(8)))
