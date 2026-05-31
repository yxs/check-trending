import type {
  CaseRecord,
  CheckDepth,
  CheckDepthBucket,
  CurrentStatus,
  DailyClearPoint,
  Filters,
  LowTideRun,
  MovingAveragePoint,
  PendingBacklog,
  RegionFilter,
  VisaSubtype,
  VisaGroup,
} from './types';

export const LONG_CHECK_THRESHOLDS = [90, 180, 270] as const;

const MAINLAND_CONSULATES = new Set(['BeiJing', 'ShangHai', 'GuangZhou', 'ShenYang', 'WuHan', 'ChengDu']);

export function hasNote(record: CaseRecord): boolean {
  return Boolean(record.detail?.Note?.trim());
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

export function getCheckDepth(record: CaseRecord): CheckDepthBucket {
  const waitingDays = record.waiting_days ?? 0;
  if (waitingDays >= 270) {
    return 'gte270';
  }
  if (waitingDays >= 180) {
    return 'gte180';
  }
  if (waitingDays >= 90) {
    return 'gte90';
  }
  if (waitingDays >= 60) {
    return 'gte60';
  }
  if (waitingDays >= 30) {
    return 'gte30';
  }
  if (waitingDays >= 7) {
    return 'gte7';
  }
  return 'lt7';
}

export function matchesCheckDepth(record: CaseRecord, checkDepth: CheckDepth): boolean {
  if (checkDepth === 'all') {
    return true;
  }
  const waitingDays = record.waiting_days ?? 0;
  const thresholds: Record<Exclude<CheckDepth, 'all'>, number> = {
    gte7: 7,
    gte30: 30,
    gte60: 60,
    gte90: 90,
    gte180: 180,
    gte270: 270,
  };
  return waitingDays >= thresholds[checkDepth];
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
    if (!matchesCheckDepth(record, filters.checkDepth)) {
      return false;
    }
    if (filters.noteCohort === 'withNote' && !hasNote(record)) {
      return false;
    }
    if (filters.noteCohort === 'withoutNote' && hasNote(record)) {
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
    if (record.status !== 'Clear' || !record.complete_date) {
      continue;
    }
    const point = countsByDate.get(record.complete_date) ?? {
      date: record.complete_date,
      count: 0,
      noteCount: 0,
    };
    point.count += 1;
    if (hasNote(record)) {
      point.noteCount += 1;
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
    noteCount: 0,
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

export function getNewestRelevantDate(records: CaseRecord[]): string {
  return records.reduce((newest, record) => {
    const candidate = record.complete_date ?? record.check_date;
    return candidate > newest ? candidate : newest;
  }, '0000-00-00');
}

export function findLowTideRuns(series: DailyClearPoint[], maxDailyCount: number, minDays: number): LowTideRun[] {
  const runs: LowTideRun[] = [];
  let startDate: string | null = null;
  let endDate: string | null = null;
  let days = 0;
  let totalClears = 0;

  for (const point of series) {
    if (point.count <= maxDailyCount) {
      startDate ??= point.date;
      endDate = point.date;
      days += 1;
      totalClears += point.count;
      continue;
    }
    if (startDate && endDate && days >= minDays) {
      runs.push({ startDate, endDate, days, totalClears });
    }
    startDate = null;
    endDate = null;
    days = 0;
    totalClears = 0;
  }

  if (startDate && endDate && days >= minDays) {
    runs.push({ startDate, endDate, days, totalClears });
  }

  return runs.sort((left, right) => right.days - left.days || left.startDate.localeCompare(right.startDate));
}

export function buildCurrentStatus(series: DailyClearPoint[], maxDailyCount: number, minDays: number): CurrentStatus {
  const latestDate = series[series.length - 1]?.date ?? '';
  const lowRuns = findLowTideRuns(series, maxDailyCount, minDays);
  const currentLow = lowRuns.find((run) => run.endDate === latestDate) ?? null;
  return {
    latestDate,
    currentLow,
    clears7d: sumLastDays(series, 7),
    clears14d: sumLastDays(series, 14),
    clears30d: sumLastDays(series, 30),
  };
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

function sumLastDays(series: DailyClearPoint[], days: number): number {
  return series.slice(-days).reduce((sum, point) => sum + point.count, 0);
}

// Snapshot of how many cases are still Pending past each long-check threshold —
// a breakdown of the "处理中" headline by how long people have already waited.
export function buildPendingBacklog(
  records: CaseRecord[],
  thresholds: readonly number[] = LONG_CHECK_THRESHOLDS,
): PendingBacklog[] {
  return thresholds.map((threshold) => {
    let count = 0;
    for (const record of records) {
      if (record.status !== 'Pending') {
        continue;
      }
      if ((record.waiting_days ?? 0) >= threshold) {
        count += 1;
      }
    }
    return { threshold, count };
  });
}

