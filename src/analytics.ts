import type {
  CaseRecord,
  DailyClearPoint,
  Filters,
  Granularity,
  MovingAveragePoint,
  ClearWaitScatter,
  RegionFilter,
  TimeRangeDays,
  VisaSubtype,
  VisaGroup,
} from './types';

export const CLEAR_SCATTER_MAX_DAYS = 180;
export const LONG_CHECK_PENDING_MAX_DAYS = 365;
export const STALE_PENDING_DAYS = 365;

const MAINLAND_CONSULATES = new Set(['BeiJing', 'ShangHai', 'GuangZhou', 'ShenYang', 'WuHan', 'ChengDu']);

export function isStalePending(record: CaseRecord): boolean {
  return (
    record.status !== 'Clear' &&
    record.status !== 'Reject' &&
    (record.waiting_days ?? 0) > STALE_PENDING_DAYS
  );
}

export function getVisaGroup(visaType: string): Exclude<VisaGroup, 'all'> {
  const prefix = visaType.trim().charAt(0).toUpperCase();
  if (prefix === 'B') {
    return 'b';
  }
  if (prefix === 'H' || prefix === 'L' || prefix === 'O') {
    return 'work';
  }
  if (prefix === 'F' || prefix === 'J') {
    return 'student';
  }
  return 'other';
}

export function getVisaSubtype(visaType: string): Exclude<VisaSubtype, 'all'> | null {
  const prefix = visaType.trim().charAt(0).toUpperCase();
  if (prefix === 'H') {
    return 'h';
  }
  if (prefix === 'L') {
    return 'l';
  }
  if (prefix === 'O') {
    return 'o';
  }
  if (prefix === 'F') {
    return 'f';
  }
  if (prefix === 'J') {
    return 'j';
  }
  return null;
}

export function getRegionGroup(consulate: string): Exclude<RegionFilter, 'all'> {
  return MAINLAND_CONSULATES.has(consulate) ? 'mainland' : 'overseas';
}

export function filterCases(records: CaseRecord[], filters: Filters): CaseRecord[] {
  const newestDate = getNewestRelevantDate(records);
  const cutoff = getDateCutoff(newestDate, filters.timeRangeDays);

  return records.filter((record) => {
    if (filters.visaGroup !== 'all' && getVisaGroup(record.visa_type) !== filters.visaGroup) {
      return false;
    }
    if (filters.visaSubtype !== 'all' && getVisaSubtype(record.visa_type) !== filters.visaSubtype) {
      return false;
    }
    if (filters.region === 'mainland' || filters.region === 'overseas') {
      if (getRegionGroup(record.consulate) !== filters.region) {
        return false;
      }
    } else if (filters.region !== 'all' && record.consulate !== filters.region) {
      return false;
    }
    const activityDate = record.complete_date ?? record.check_date;
    if (cutoff && activityDate < cutoff) {
      return false;
    }
    return true;
  });
}

export function buildDailyClearSeries(records: CaseRecord[]): DailyClearPoint[] {
  const countsByDate = new Map<string, DailyClearPoint>();
  for (const record of records) {
    if (!record.complete_date || (record.status !== 'Clear' && record.status !== 'Reject')) {
      continue;
    }
    const point = countsByDate.get(record.complete_date) ?? {
      date: record.complete_date,
      count: 0,
      rejectCount: 0,
    };
    if (record.status === 'Reject') {
      point.rejectCount += 1;
    } else {
      point.count += 1;
    }
    countsByDate.set(record.complete_date, point);
  }
  const dates = [...countsByDate.keys()].sort();
  if (dates.length === 0) {
    return [];
  }
  return buildDateRange(dates[0], dates[dates.length - 1]).map((date) => countsByDate.get(date) ?? {
    date,
    count: 0,
    rejectCount: 0,
  });
}

export function movingAverage(series: DailyClearPoint[], windowSize: number): MovingAveragePoint[] {
  return series.map((point, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = series.slice(start, index + 1);
    const total = window.reduce((sum, item) => sum + item.count, 0);
    return {
      date: point.date,
      value: Number((total / window.length).toFixed(2)),
    };
  });
}

export function granularityForRange(timeRangeDays: TimeRangeDays): Granularity {
  if (timeRangeDays === 'all') {
    return 'month';
  }
  return timeRangeDays >= 365 ? 'week' : 'day';
}

export function trailingWindowForGranularity(granularity: Granularity): number {
  if (granularity === 'month') {
    return 3;
  }
  return granularity === 'week' ? 4 : 7;
}

export function bucketClearSeries(series: DailyClearPoint[], granularity: Granularity): DailyClearPoint[] {
  if (granularity === 'day') {
    return series;
  }
  const keyOf = granularity === 'month' ? monthStart : weekStart;
  const buckets = new Map<string, DailyClearPoint>();
  for (const point of series) {
    const key = keyOf(point.date);
    const bucket = buckets.get(key) ?? { date: key, count: 0, rejectCount: 0 };
    bucket.count += point.count;
    bucket.rejectCount += point.rejectCount;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function weekStart(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const isoDayOfWeek = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - isoDayOfWeek);
  return value.toISOString().slice(0, 10);
}

export function getNewestRelevantDate(records: CaseRecord[]): string {
  return records.reduce((newest, record) => {
    const candidate = record.complete_date ?? record.check_date;
    return candidate > newest ? candidate : newest;
  }, '0000-00-00');
}

export function getDateTickIndexes(dates: string[], stepPx: number, minSpacingPx: number): number[] {
  if (dates.length === 0) {
    return [];
  }
  const indexes: number[] = [0];
  let lastX = 0;
  for (let index = 1; index < dates.length - 1; index += 1) {
    const x = index * stepPx;
    if (x - lastX >= minSpacingPx) {
      indexes.push(index);
      lastX = x;
    }
  }
  if (dates.length > 1) {
    const lastIndex = dates.length - 1;
    const lastLabelX = lastIndex * stepPx;
    if (lastLabelX - lastX >= minSpacingPx * 0.75) {
      indexes.push(lastIndex);
    } else {
      indexes[indexes.length - 1] = lastIndex;
    }
  }
  return indexes;
}

function getDateCutoff(newestDate: string, timeRangeDays: Filters['timeRangeDays']): string | null {
  if (timeRangeDays === 'all') {
    return null;
  }
  const newest = new Date(`${newestDate}T00:00:00Z`);
  newest.setUTCDate(newest.getUTCDate() - timeRangeDays + 1);
  return newest.toISOString().slice(0, 10);
}

function buildDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function buildClearWaitScatter(records: CaseRecord[]): ClearWaitScatter {
  const days: number[] = [];
  for (const record of records) {
    if (record.status !== 'Clear' || record.waiting_days == null) {
      continue;
    }
    const day = record.waiting_days;
    if (day >= 0 && day < CLEAR_SCATTER_MAX_DAYS) {
      days.push(day);
    }
  }
  return { days, total: days.length };
}

