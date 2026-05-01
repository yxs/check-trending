import type {
  CheckDepth,
  Filters,
  LowTideThreshold,
  NoteCohort,
  TimeRangeDays,
  VisaGroup,
  VisaSubtype,
} from './types';

type ViewState = {
  filters: Filters;
  lowTideThreshold: LowTideThreshold;
};

const CHECK_DEPTH_VALUES: CheckDepth[] = ['all', 'gte7', 'gte30', 'gte60', 'gte90'];
const NOTE_COHORT_VALUES: NoteCohort[] = ['all', 'withNote', 'withoutNote'];
const VISA_GROUP_VALUES: VisaGroup[] = ['all', 'b', 'work', 'student', 'other'];
const LOW_TIDE_VALUES: LowTideThreshold[] = [1, 2, 5];
const TIME_RANGE_PARAM_TO_VALUE: Record<string, TimeRangeDays> = {
  all: 'all',
  '30': 30,
  '60': 60,
  '90': 90,
  '180': 180,
};
const TIME_RANGE_VALUE_TO_PARAM: Record<string, string> = {
  all: 'all',
  '30': '30',
  '60': '60',
  '90': '90',
  '180': '180',
};
const ALLOWED_SUBTYPE_BY_GROUP: Record<VisaGroup, VisaSubtype[]> = {
  all: ['all'],
  b: ['all'],
  other: ['all'],
  work: ['all', 'h', 'l', 'o'],
  student: ['all', 'f', 'j'],
};

export function readViewStateFromSearch(
  search: string,
  defaultFilters: Filters,
  defaultLowTideThreshold: LowTideThreshold,
): ViewState {
  const params = new URLSearchParams(search);

  const visaGroup = pickOrDefault(params.get('vg'), VISA_GROUP_VALUES, defaultFilters.visaGroup);
  const visaSubtype = pickOrDefault(params.get('vs'), ALLOWED_SUBTYPE_BY_GROUP[visaGroup], defaultFilters.visaSubtype);
  const checkDepth = pickOrDefault(params.get('d'), CHECK_DEPTH_VALUES, defaultFilters.checkDepth);
  const noteCohort = pickOrDefault(params.get('n'), NOTE_COHORT_VALUES, defaultFilters.noteCohort);
  const region = normalizeRegion(params.get('r'), defaultFilters.region);
  const timeRangeDays = parseTimeRange(params.get('t'), defaultFilters.timeRangeDays);
  const selectedDate = normalizeDate(params.get('s'));
  const lowTideThreshold = parseLowTideThreshold(params.get('lt'), defaultLowTideThreshold);

  return {
    filters: {
      checkDepth,
      noteCohort,
      region,
      selectedDate,
      timeRangeDays,
      visaGroup,
      visaSubtype,
    },
    lowTideThreshold,
  };
}

export function buildSearchFromViewState(
  filters: Filters,
  lowTideThreshold: LowTideThreshold,
  defaultFilters: Filters,
  defaultLowTideThreshold: LowTideThreshold,
): string {
  const params = new URLSearchParams();

  if (filters.visaGroup !== defaultFilters.visaGroup) {
    params.set('vg', filters.visaGroup);
  }
  if (filters.visaSubtype !== defaultFilters.visaSubtype) {
    params.set('vs', filters.visaSubtype);
  }
  if (filters.checkDepth !== defaultFilters.checkDepth) {
    params.set('d', filters.checkDepth);
  }
  if (filters.noteCohort !== defaultFilters.noteCohort) {
    params.set('n', filters.noteCohort);
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
  if (lowTideThreshold !== defaultLowTideThreshold) {
    params.set('lt', String(lowTideThreshold));
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

function parseLowTideThreshold(value: string | null, fallback: LowTideThreshold): LowTideThreshold {
  if (!value) {
    return fallback;
  }
  const numberValue = Number(value);
  return LOW_TIDE_VALUES.includes(numberValue as LowTideThreshold) ? (numberValue as LowTideThreshold) : fallback;
}
