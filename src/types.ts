export interface CaseRecord {
  case_number: string;
  check_date: string;
  complete_date: string | null;
  consulate: string;
  has_note?: boolean;
  note_richness_score?: number;
  note_signal_count?: number;
  note_timeline_count?: number;
  note_updated_at?: string | null;
  status: 'Clear' | 'Pending' | 'Reject' | string;
  visa_type: string;
  waiting_days: number | null;
}

export type VisaGroup = 'all' | 'b' | 'work' | 'student' | 'other';
export type VisaSubtype = 'all' | 'h' | 'l' | 'o' | 'f' | 'j';
export type RegionFilter = 'all' | 'mainland' | 'overseas' | (string & {});
export type TimeRangeDays = 'all' | 90 | 180 | 365 | 730;
export type Granularity = 'day' | 'week' | 'month';

export type DetailStatus = 'all' | 'Clear' | 'Reject' | 'Pending' | 'over180' | 'over1y' | 'longCheckNotes';
export type DetailSort = { key: 'check' | 'clear' | 'wait'; dir: 'asc' | 'desc' };

export interface Filters {
  region: RegionFilter;
  selectedDate: string | null;
  timeRangeDays: TimeRangeDays;
  visaGroup: VisaGroup;
  visaSubtype: VisaSubtype;
}

export interface DailyClearPoint {
  date: string;
  count: number;
  rejectCount: number;
}

export interface MovingAveragePoint {
  date: string;
  value: number;
}

export interface ClearWaitScatter {
  days: number[];
  total: number;
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
