export interface CaseRecord {
  case_number: string;
  check_date: string;
  complete_date: string | null;
  consulate: string;
  detail: Record<string, string>;
  detail_url: string;
  display_id: string;
  major: string;
  month: string;
  status: 'Clear' | 'Pending' | 'Reject' | string;
  visa_entry: string;
  visa_type: string;
  waiting_days: number | null;
}

export type VisaGroup = 'all' | 'b' | 'work' | 'student' | 'other';
export type VisaSubtype = 'all' | 'h' | 'l' | 'o' | 'f' | 'j';
export type CheckDepth = 'all' | 'gte7' | 'gte30' | 'gte60' | 'gte90';
export type CheckDepthBucket = 'lt7' | Exclude<CheckDepth, 'all'>;
export type NoteCohort = 'all' | 'withNote' | 'withoutNote';
export type RegionFilter = 'all' | 'mainland' | 'overseas' | (string & {});
export type TimeRangeDays = 'all' | 30 | 60 | 90 | 180;
export type LowTideThreshold = 1 | 2 | 5;
export type ChartWindowDays = number;

export interface Filters {
  checkDepth: CheckDepth;
  noteCohort: NoteCohort;
  region: RegionFilter;
  selectedDate: string | null;
  timeRangeDays: TimeRangeDays;
  visaGroup: VisaGroup;
  visaSubtype: VisaSubtype;
}

export interface DailyClearPoint {
  date: string;
  count: number;
  noteCount: number;
}

export interface MovingAveragePoint {
  date: string;
  value: number;
}

export interface LowTideRun {
  startDate: string;
  endDate: string;
  days: number;
  totalClears: number;
}

export interface HighTideRun {
  startDate: string;
  endDate: string;
  days: number;
  totalClears: number;
}

export interface WaveEvent {
  low: LowTideRun;
  high: HighTideRun;
  gapDays: number;
}

export interface CurrentStatus {
  latestDate: string;
  currentLow: LowTideRun | null;
  clears7d: number;
  clears14d: number;
  clears30d: number;
}

export interface ForecastPoint {
  date: string;
  value: number;
}

export interface WebDataSummary {
  generated_at: string;
  case_count: number;
  note_count: number;
  start_date: string;
  end_date: string;
}

export interface WebData {
  cases: CaseRecord[];
  summary: WebDataSummary;
}
