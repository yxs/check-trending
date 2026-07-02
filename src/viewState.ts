import type {
  DetailSort,
  DetailStatus,
  Filters,
  TimeRangeDays,
  VisaGroup,
  VisaSubtype,
} from './types';

type ViewState = {
  filters: Filters;
  detailStatus: DetailStatus;
  detailSort: DetailSort;
};

const VISA_GROUP_VALUES: VisaGroup[] = ['all', 'b', 'work', 'student', 'other'];
const DETAIL_STATUS_VALUES: DetailStatus[] = [
  'all',
  'Clear',
  'Reject',
  'Pending',
  'over180',
  'over1y',
  'longCheckNotes',
];
const SORT_KEYS: DetailSort['key'][] = ['check', 'clear', 'wait'];
const DEFAULT_DETAIL_SORT: DetailSort = { key: 'clear', dir: 'desc' };
const TIME_RANGE_PARAM_TO_VALUE: Record<string, TimeRangeDays> = {
  all: 'all',
  '90': 90,
  '180': 180,
  '365': 365,
  '730': 730,
};
const TIME_RANGE_VALUE_TO_PARAM: Record<string, string> = {
  all: 'all',
  '90': '90',
  '180': '180',
  '365': '365',
  '730': '730',
};
const ALLOWED_SUBTYPE_BY_GROUP: Record<VisaGroup, VisaSubtype[]> = {
  all: ['all'],
  b: ['all'],
  other: ['all'],
  work: ['all', 'h', 'l', 'o'],
  student: ['all', 'f', 'j'],
};

export function readViewStateFromSearch(search: string, defaultFilters: Filters): ViewState {
  const params = new URLSearchParams(search);

  const visaGroup = pickOrDefault(params.get('vg'), VISA_GROUP_VALUES, defaultFilters.visaGroup);
  const visaSubtype = pickOrDefault(params.get('vs'), ALLOWED_SUBTYPE_BY_GROUP[visaGroup], defaultFilters.visaSubtype);
  const region = normalizeRegion(params.get('r'), defaultFilters.region);
  const timeRangeDays = parseTimeRange(params.get('t'), defaultFilters.timeRangeDays);
  const detailStatus = pickOrDefault(params.get('ds'), DETAIL_STATUS_VALUES, 'all');
  const detailSort = parseDetailSort(params.get('sort'));
  // over1y / Pending are global cohorts that ignore a selected date; drop a stray ?s= so
  // the chart and the detail table can't disagree on a shared/hand-edited URL.
  const cohortMode =
    detailStatus === 'over1y' ||
    detailStatus === 'over180' ||
    detailStatus === 'Pending' ||
    detailStatus === 'longCheckNotes';
  const selectedDate = cohortMode ? null : normalizeDate(params.get('s'));

  return {
    filters: {
      region,
      selectedDate,
      timeRangeDays,
      visaGroup,
      visaSubtype,
    },
    detailStatus,
    detailSort,
  };
}

function parseDetailSort(value: string | null): DetailSort {
  if (value) {
    const [key, dir] = value.split('-');
    if (SORT_KEYS.includes(key as DetailSort['key']) && (dir === 'asc' || dir === 'desc')) {
      return { key: key as DetailSort['key'], dir };
    }
  }
  return DEFAULT_DETAIL_SORT;
}

export function buildSearchFromViewState(
  filters: Filters,
  defaultFilters: Filters,
  detailStatus: DetailStatus = 'all',
  detailSort: DetailSort = DEFAULT_DETAIL_SORT,
): string {
  const params = new URLSearchParams();

  if (filters.visaGroup !== defaultFilters.visaGroup) {
    params.set('vg', filters.visaGroup);
  }
  if (filters.visaSubtype !== defaultFilters.visaSubtype) {
    params.set('vs', filters.visaSubtype);
  }
  if (filters.region !== defaultFilters.region) {
    params.set('r', filters.region);
  }
  if (filters.timeRangeDays !== defaultFilters.timeRangeDays) {
    params.set('t', TIME_RANGE_VALUE_TO_PARAM[String(filters.timeRangeDays)]);
  }
  if (filters.selectedDate) {
    params.set('s', filters.selectedDate);
  }
  if (detailStatus !== 'all') {
    params.set('ds', detailStatus);
  }
  if (detailSort.key !== DEFAULT_DETAIL_SORT.key || detailSort.dir !== DEFAULT_DETAIL_SORT.dir) {
    params.set('sort', `${detailSort.key}-${detailSort.dir}`);
  }

  return params.toString();
}

function pickOrDefault<T extends string>(value: string | null, options: T[], fallback: T): T {
  if (value && options.includes(value as T)) {
    return value as T;
  }
  return fallback;
}

function normalizeRegion(value: string | null, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function normalizeDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function parseTimeRange(value: string | null, fallback: TimeRangeDays): TimeRangeDays {
  if (!value) {
    return fallback;
  }
  return TIME_RANGE_PARAM_TO_VALUE[value] ?? fallback;
}
