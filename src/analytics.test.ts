import { describe, expect, it } from 'vitest';

import {
  buildCurrentStatus,
  buildDailyClearSeries,
  buildLongCheckShareSeries,
  buildPendingBacklog,
  buildWaitDistributionByMonth,
  buildWaitScatterPoints,
  filterCases,
  findLowTideRuns,
  getCheckDepth,
  getDateTickIndexes,
  getRegionGroup,
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
  detail: { Note: '' },
  detail_url: 'https://example.com',
  display_id: 'demo',
  major: 'CS',
  month: '2025-12',
  status: 'Clear',
  visa_entry: 'New',
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

  it('converts waiting days into check depth buckets', () => {
    expect(getCheckDepth(makeCase({ waiting_days: 6 }))).toBe('lt7');
    expect(getCheckDepth(makeCase({ waiting_days: 30 }))).toBe('gte30');
    expect(getCheckDepth(makeCase({ waiting_days: 60 }))).toBe('gte60');
    expect(getCheckDepth(makeCase({ waiting_days: 90 }))).toBe('gte90');
    expect(getCheckDepth(makeCase({ waiting_days: 180 }))).toBe('gte180');
    expect(getCheckDepth(makeCase({ waiting_days: 300 }))).toBe('gte270');
  });
});

describe('filtering and daily clear series', () => {
  const cases: CaseRecord[] = [
    makeCase({ case_number: '1', complete_date: '2026-01-10', visa_type: 'H1', waiting_days: 40, detail: { Note: 'has note' } }),
    makeCase({ case_number: '2', complete_date: '2026-01-10', visa_type: 'B2', waiting_days: 65, detail: { Note: '' } }),
    makeCase({ case_number: '3', complete_date: '2026-01-11', visa_type: 'L1', waiting_days: 70, consulate: 'Toronto', detail: { Note: 'passport submitted' } }),
    makeCase({ case_number: '4', complete_date: null, visa_type: 'O1', status: 'Pending', waiting_days: 100, consulate: 'Europe', detail: { Note: 'pending' } }),
  ];

  it('applies visa group, depth, note, region, and status filters together', () => {
    const filters: Filters = {
      checkDepth: 'gte60',
      noteCohort: 'withNote',
      region: 'overseas',
      selectedDate: null,
      timeRangeDays: 'all',
      visaGroup: 'work',
      visaSubtype: 'all',
    };

    expect(filterCases(cases, filters).map((item) => item.case_number)).toEqual(['3', '4']);
  });

  it('applies student visa subtype filters', () => {
    const records = [
      makeCase({ case_number: 'f', visa_type: 'F1', waiting_days: 80 }),
      makeCase({ case_number: 'j', visa_type: 'J1', waiting_days: 80 }),
      makeCase({ case_number: 'b', visa_type: 'B1', waiting_days: 80 }),
    ];

    expect(filterCases(records, {
      checkDepth: 'gte60',
      noteCohort: 'all',
      region: 'all',
      selectedDate: null,
      timeRangeDays: 'all',
      visaGroup: 'student',
      visaSubtype: 'f',
    }).map((item) => item.case_number)).toEqual(['f']);
  });

  it('builds daily clear counts and note counts', () => {
    const series = buildDailyClearSeries([
      ...cases,
      makeCase({ case_number: '5', complete_date: '2026-01-12', visa_type: 'H1', waiting_days: 40 }),
    ]);

    expect(series).toEqual([
      { date: '2026-01-10', count: 2, noteCount: 1 },
      { date: '2026-01-11', count: 1, noteCount: 1 },
      { date: '2026-01-12', count: 1, noteCount: 0 },
    ]);
  });

  it('keeps zero-clear calendar days inside the series', () => {
    const series = buildDailyClearSeries([
      makeCase({ case_number: '1', complete_date: '2026-01-10' }),
      makeCase({ case_number: '2', complete_date: '2026-01-13' }),
    ]);

    expect(series).toEqual([
      { date: '2026-01-10', count: 1, noteCount: 0 },
      { date: '2026-01-11', count: 0, noteCount: 0 },
      { date: '2026-01-12', count: 0, noteCount: 0 },
      { date: '2026-01-13', count: 1, noteCount: 0 },
    ]);
  });

  it('finds low tide runs across consecutive low-count days', () => {
    const runs = findLowTideRuns(
      [
        { date: '2026-01-01', count: 2, noteCount: 0 },
        { date: '2026-01-02', count: 1, noteCount: 0 },
        { date: '2026-01-03', count: 0, noteCount: 0 },
        { date: '2026-01-04', count: 1, noteCount: 0 },
        { date: '2026-01-05', count: 3, noteCount: 0 },
      ],
      1,
      3,
    );

    expect(runs).toEqual([{ startDate: '2026-01-02', endDate: '2026-01-04', days: 3, totalClears: 2 }]);
  });

  it('builds current status from latest low tide and recent windows', () => {
    const status = buildCurrentStatus(
      [
        { date: '2026-01-01', count: 8, noteCount: 0 },
        { date: '2026-01-02', count: 1, noteCount: 0 },
        { date: '2026-01-03', count: 0, noteCount: 0 },
        { date: '2026-01-04', count: 1, noteCount: 0 },
      ],
      1,
      3,
    );

    expect(status.currentLow).toEqual({ startDate: '2026-01-02', endDate: '2026-01-04', days: 3, totalClears: 2 });
    expect(status.clears7d).toBe(10);
    expect(status.latestDate).toBe('2026-01-04');
  });

  it('chooses date tick indexes by pixel spacing', () => {
    const dates = ['2025-12-21', '2025-12-31', '2026-01-01', '2026-01-11', '2026-01-21'];

    expect(getDateTickIndexes(dates, 20, 55)).toEqual([0, 4]);
  });

  it('builds wait scatter points only from clear cases with both dates', () => {
    const records = [
      makeCase({ case_number: '1', complete_date: '2026-01-10', waiting_days: 40 }),
      makeCase({ case_number: '2', complete_date: '2026-01-11', waiting_days: 90 }),
      makeCase({ case_number: '3', complete_date: null, status: 'Pending', waiting_days: 30 }),
      makeCase({ case_number: '4', complete_date: '2026-01-10', waiting_days: null as unknown as number }),
    ];
    const points = buildWaitScatterPoints(records);
    expect(points.map((point) => point.caseNumber)).toEqual(['1', '2']);
    expect(points[0].visaGroup).toBe('work');
  });

  it('computes long-check rolling share over a smoothing window with custom thresholds', () => {
    const records = [
      makeCase({ case_number: 'a', complete_date: '2026-01-01', waiting_days: 30 }),
      makeCase({ case_number: 'b', complete_date: '2026-01-01', waiting_days: 100 }),
      makeCase({ case_number: 'c', complete_date: '2026-01-02', waiting_days: 200 }),
      makeCase({ case_number: 'd', complete_date: '2026-01-03', waiting_days: 30 }),
    ];
    const { daily, smoothed } = buildLongCheckShareSeries(records, [90, 180], 3);
    expect(daily.map((point) => point.total)).toEqual([2, 1, 1]);
    expect(daily.map((point) => point.counts[90])).toEqual([1, 1, 0]);
    expect(daily.map((point) => point.counts[180])).toEqual([0, 1, 0]);
    expect(smoothed[2]).toEqual({
      date: '2026-01-03',
      total: 4,
      shares: { 90: 0.5, 180: 0.25 },
    });
  });

  it('counts pending cases at each long-wait threshold', () => {
    const records = [
      makeCase({ case_number: '1', status: 'Pending', complete_date: null, waiting_days: 95 }),
      makeCase({ case_number: '2', status: 'Pending', complete_date: null, waiting_days: 200 }),
      makeCase({ case_number: '3', status: 'Pending', complete_date: null, waiting_days: 280 }),
      makeCase({ case_number: '4', status: 'Clear', complete_date: '2026-01-01', waiting_days: 300 }),
    ];
    expect(buildPendingBacklog(records, [90, 180, 270])).toEqual([
      { threshold: 90, count: 3 },
      { threshold: 180, count: 2 },
      { threshold: 270, count: 1 },
    ]);
  });

  it('summarises wait distribution by clear month', () => {
    const records = [
      makeCase({ case_number: '1', complete_date: '2026-01-05', waiting_days: 20 }),
      makeCase({ case_number: '2', complete_date: '2026-01-15', waiting_days: 40 }),
      makeCase({ case_number: '3', complete_date: '2026-01-25', waiting_days: 80 }),
      makeCase({ case_number: '4', complete_date: '2026-02-05', waiting_days: 100 }),
    ];
    const distribution = buildWaitDistributionByMonth(records);
    expect(distribution).toHaveLength(2);
    expect(distribution[0].month).toBe('2026-01');
    expect(distribution[0].count).toBe(3);
    expect(distribution[0].p25).toBe(20);
    expect(distribution[0].p50).toBe(40);
    expect(distribution[0].max).toBe(80);
    expect(distribution[1].month).toBe('2026-02');
    expect(distribution[1].p50).toBe(100);
  });

  it('computes trailing moving averages', () => {
    const series = [
      { date: '2026-01-01', count: 1, noteCount: 0 },
      { date: '2026-01-02', count: 3, noteCount: 1 },
      { date: '2026-01-03', count: 5, noteCount: 2 },
    ];

    expect(movingAverage(series, 2)).toEqual([
      { date: '2026-01-01', value: 1 },
      { date: '2026-01-02', value: 2 },
      { date: '2026-01-03', value: 4 },
    ]);
  });
});
