import { describe, expect, it } from 'vitest';

import {
  buildLongCheckNoteSummary,
  bucketClearSeries,
  buildClearWaitScatter,
  buildDailyClearSeries,
  filterCases,
  getDateTickIndexes,
  getRegionGroup,
  granularityForRange,
  getVisaGroup,
  getVisaSubtype,
  movingAverage,
} from './analytics';
import type { CaseRecord, Filters } from './types';

const baseCase: CaseRecord = {
  case_number: '1',
  check_date: '2025-12-01',
  complete_date: '2026-01-10',
  consulate: 'BeiJing',
  status: 'Clear',
  visa_type: 'H1',
  waiting_days: 40,
};

function makeCase(overrides: Partial<CaseRecord>): CaseRecord {
  return { ...baseCase, ...overrides };
}

describe('analytics grouping', () => {
  it('groups visas using the product categories from the data', () => {
    expect(getVisaGroup('B1')).toBe('b');
    expect(getVisaGroup('B2')).toBe('b');
    expect(getVisaGroup('H1')).toBe('work');
    expect(getVisaGroup('L1')).toBe('work');
    expect(getVisaGroup('O1')).toBe('work');
    expect(getVisaGroup('F1')).toBe('student');
    expect(getVisaGroup('J1')).toBe('student');
    expect(getVisaGroup('X1')).toBe('other');
  });

  it('detects visa subtypes and mainland/overseas region groups', () => {
    expect(getVisaSubtype('H4')).toBe('h');
    expect(getVisaSubtype('L2')).toBe('l');
    expect(getVisaSubtype('O1')).toBe('o');
    expect(getVisaSubtype('F1')).toBe('f');
    expect(getVisaSubtype('J2')).toBe('j');
    expect(getVisaSubtype('B2')).toBe(null);
    expect(getRegionGroup('ShangHai')).toBe('mainland');
    expect(getRegionGroup('HongKong')).toBe('overseas');
    expect(getRegionGroup('Vancouver')).toBe('overseas');
  });
});

describe('clear wait scatter', () => {
  it('collects Clear cases that cleared within 180 days', () => {
    const cases = [
      makeCase({ status: 'Clear', waiting_days: 5 }),    // in range
      makeCase({ status: 'Clear', waiting_days: 95 }),   // in range
      makeCase({ status: 'Clear', waiting_days: 179 }),  // in range (< 180)
      makeCase({ status: 'Clear', waiting_days: 180 }),  // >= 180 -> excluded
      makeCase({ status: 'Clear', waiting_days: 400 }),  // excluded
      makeCase({ status: 'Pending', waiting_days: 100 }),// not Clear -> excluded
      makeCase({ status: 'Clear', waiting_days: null }), // null wait -> excluded
    ];
    const scatter = buildClearWaitScatter(cases);
    expect(scatter.days).toEqual([5, 95, 179]);
    expect(scatter.total).toBe(3);
  });

  it('returns an empty scatter when no Clear cases fall within 180 days', () => {
    expect(buildClearWaitScatter([makeCase({ status: 'Clear', waiting_days: 400 })])).toEqual({
      days: [],
      total: 0,
    });
  });
});

describe('long check notes', () => {
  it('keeps all statuses between 180 and 730 days with notes and ranks semantic-rich notes first', () => {
    const records = [
      makeCase({
        case_number: 'pending-rich',
        check_date: '2026-01-20',
        status: 'Pending',
        complete_date: null,
        waiting_days: 220,
        has_note: true,
        note_richness_score: 8,
      }),
      makeCase({
        case_number: 'clear-richest',
        check_date: '2026-01-10',
        status: 'Clear',
        waiting_days: 260,
        has_note: true,
        note_richness_score: 12,
      }),
      makeCase({
        case_number: 'reject-mid',
        check_date: '2026-02-01',
        status: 'Reject',
        waiting_days: 240,
        has_note: true,
        note_richness_score: 6,
      }),
      makeCase({
        case_number: 'too-new',
        check_date: '2026-03-01',
        status: 'Pending',
        complete_date: null,
        waiting_days: 179,
        has_note: true,
        note_richness_score: 12,
      }),
      makeCase({
        case_number: 'too-old',
        check_date: '2025-03-01',
        status: 'Pending',
        complete_date: null,
        waiting_days: 730,
        has_note: true,
        note_richness_score: 12,
      }),
      makeCase({
        case_number: 'no-note',
        check_date: '2026-03-01',
        status: 'Pending',
        complete_date: null,
        waiting_days: 220,
        has_note: false,
        note_richness_score: 12,
      }),
      makeCase({
        case_number: 'outside-recent-window',
        check_date: '2023-12-01',
        status: 'Clear',
        waiting_days: 260,
        has_note: true,
        note_richness_score: 12,
      }),
    ];

    const summary = buildLongCheckNoteSummary(records, '2026-06-28');

    expect(summary.total).toBe(3);
    expect(summary.richTotal).toBe(2);
    expect(summary.candidates.map((record) => record.case_number)).toEqual([
      'clear-richest',
      'pending-rich',
      'reject-mid',
    ]);
  });
});

describe('filtering and daily clear series', () => {
  const cases: CaseRecord[] = [
    makeCase({ case_number: '1', complete_date: '2026-01-10', visa_type: 'H1', waiting_days: 40 }),
    makeCase({ case_number: '2', complete_date: '2026-01-10', visa_type: 'B2', waiting_days: 65 }),
    makeCase({ case_number: '3', complete_date: '2026-01-11', visa_type: 'L1', waiting_days: 70, consulate: 'Toronto' }),
    makeCase({ case_number: '4', complete_date: null, visa_type: 'O1', status: 'Pending', waiting_days: 100, consulate: 'Europe' }),
  ];

  it('applies visa group, region, and status filters together', () => {
    const filters: Filters = {
      region: 'overseas',
      selectedDate: null,
      timeRangeDays: 'all',
      visaGroup: 'work',
      visaSubtype: 'all',
    };

    expect(filterCases(cases, filters).map((item) => item.case_number)).toEqual(['3', '4']);
  });

  it('returns an empty list without throwing when records are empty and a time range is set', () => {
    for (const timeRangeDays of [90, 180, 365, 730] as const) {
      expect(() =>
        filterCases([], {
          region: 'all',
          selectedDate: null,
          timeRangeDays,
          visaGroup: 'all',
          visaSubtype: 'all',
        }),
      ).not.toThrow();
    }
  });

  it('applies student visa subtype filters', () => {
    const records = [
      makeCase({ case_number: 'f', visa_type: 'F1', waiting_days: 80 }),
      makeCase({ case_number: 'j', visa_type: 'J1', waiting_days: 80 }),
      makeCase({ case_number: 'b', visa_type: 'B1', waiting_days: 80 }),
    ];

    expect(filterCases(records, {
      region: 'all',
      selectedDate: null,
      timeRangeDays: 'all',
      visaGroup: 'student',
      visaSubtype: 'f',
    }).map((item) => item.case_number)).toEqual(['f']);
  });

  it('builds daily clear and reject counts by completion date', () => {
    const series = buildDailyClearSeries([
      ...cases,
      makeCase({ case_number: '5', complete_date: '2026-01-12', visa_type: 'H1', waiting_days: 40 }),
      makeCase({ case_number: '6', complete_date: '2026-01-11', status: 'Reject', waiting_days: 50 }),
    ]);

    expect(series).toEqual([
      { date: '2026-01-10', count: 2, rejectCount: 0 },
      { date: '2026-01-11', count: 1, rejectCount: 1 },
      { date: '2026-01-12', count: 1, rejectCount: 0 },
    ]);
  });

  it('keeps zero-clear calendar days inside the series', () => {
    const series = buildDailyClearSeries([
      makeCase({ case_number: '1', complete_date: '2026-01-10' }),
      makeCase({ case_number: '2', complete_date: '2026-01-13' }),
    ]);

    expect(series).toEqual([
      { date: '2026-01-10', count: 1, rejectCount: 0 },
      { date: '2026-01-11', count: 0, rejectCount: 0 },
      { date: '2026-01-12', count: 0, rejectCount: 0 },
      { date: '2026-01-13', count: 1, rejectCount: 0 },
    ]);
  });

  it('chooses date tick indexes by pixel spacing', () => {
    const dates = ['2025-12-21', '2025-12-31', '2026-01-01', '2026-01-11', '2026-01-21'];

    expect(getDateTickIndexes(dates, 20, 55)).toEqual([0, 4]);
  });

  it('computes trailing moving averages', () => {
    const series = [
      { date: '2026-01-01', count: 1, rejectCount: 0 },
      { date: '2026-01-02', count: 3, rejectCount: 1 },
      { date: '2026-01-03', count: 5, rejectCount: 2 },
    ];

    expect(movingAverage(series, 2)).toEqual([
      { date: '2026-01-01', value: 1 },
      { date: '2026-01-02', value: 2 },
      { date: '2026-01-03', value: 4 },
    ]);
  });
});

describe('chart granularity', () => {
  it('maps the time range to a display granularity', () => {
    expect(granularityForRange('all')).toBe('month');
    expect(granularityForRange(730)).toBe('week');
    expect(granularityForRange(365)).toBe('week');
    expect(granularityForRange(180)).toBe('day');
    expect(granularityForRange(90)).toBe('day');
  });

  it('returns the daily series unchanged at day granularity', () => {
    const daily = [
      { date: '2026-01-01', count: 2, rejectCount: 1 },
      { date: '2026-01-02', count: 0, rejectCount: 0 },
    ];
    expect(bucketClearSeries(daily, 'day')).toBe(daily);
  });

  it('sums daily points into calendar-month buckets', () => {
    const daily = [
      { date: '2026-01-05', count: 2, rejectCount: 1 },
      { date: '2026-01-20', count: 3, rejectCount: 0 },
      { date: '2026-02-02', count: 4, rejectCount: 2 },
    ];
    expect(bucketClearSeries(daily, 'month')).toEqual([
      { date: '2026-01-01', count: 5, rejectCount: 1 },
      { date: '2026-02-01', count: 4, rejectCount: 2 },
    ]);
  });

  it('sums daily points into Monday-anchored week buckets', () => {
    // 2026-01-05 is a Monday; 2026-01-11 Sunday; 2026-01-12 next Monday.
    const daily = [
      { date: '2026-01-07', count: 1, rejectCount: 0 },
      { date: '2026-01-11', count: 2, rejectCount: 1 },
      { date: '2026-01-12', count: 5, rejectCount: 0 },
    ];
    expect(bucketClearSeries(daily, 'week')).toEqual([
      { date: '2026-01-05', count: 3, rejectCount: 1 },
      { date: '2026-01-12', count: 5, rejectCount: 0 },
    ]);
  });
});
