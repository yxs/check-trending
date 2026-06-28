// Client-side full-text search over the historical Note corpus
// (public/data/notes.json — every checkee case 2017→now that carried a Note).
// Pure, framework-free helpers so the matching logic stays unit-testable.
import { getRegionGroup, getVisaGroup } from './analytics';
import type { VisaGroup } from './types';

// Compact corpus record. Short keys keep the 17k-record payload small; they are
// expanded to readable accessors here so the rest of the app never juggles them.
export interface NoteCase {
  cn: string; // case_number
  id: string; // display_id
  vt: string; // visa_type
  ve: string; // visa_entry
  co: string; // consulate
  mj: string; // major
  st: string; // status
  cd: string; // check_date
  cp: string | null; // complete_date
  wd: number | null; // waiting_days
  nt: string; // note (raw, newlines preserved)
}

export interface NotesData {
  generated_at: string;
  count: number;
  start_date: string;
  end_date: string;
  cases: NoteCase[];
}

export type NoteStatus = 'all' | 'Clear' | 'Pending' | 'Reject';
export type NoteRegion = 'all' | 'mainland' | 'overseas';

export interface NoteFilters {
  visaGroup: VisaGroup;
  status: NoteStatus;
  year: string; // 'all' | 'YYYY'
  region: NoteRegion;
}

export const DEFAULT_NOTE_FILTERS: NoteFilters = {
  visaGroup: 'all',
  status: 'all',
  year: 'all',
  region: 'all',
};

export function detailUrl(caseNumber: string): string {
  return `https://www.checkee.info/personal_detail.php?casenum=${caseNumber}`;
}

export function noteYear(record: NoteCase): string {
  return record.cd.slice(0, 4);
}

// Lowercased haystack: the note plus the metadata people actually search by
// (school/major, consulate, visa, id). Built once per case and reused.
export function buildSearchBlob(record: NoteCase): string {
  return [record.nt, record.mj, record.co, record.vt, record.ve, record.id, record.st]
    .join('  ')
    .toLowerCase();
}

export function parseTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesFilters(record: NoteCase, filters: NoteFilters): boolean {
  if (filters.visaGroup !== 'all' && getVisaGroup(record.vt) !== filters.visaGroup) {
    return false;
  }
  if (filters.status !== 'all' && record.st !== filters.status) {
    return false;
  }
  if (filters.year !== 'all' && noteYear(record) !== filters.year) {
    return false;
  }
  if (filters.region !== 'all' && getRegionGroup(record.co) !== filters.region) {
    return false;
  }
  return true;
}

export interface SearchResult {
  total: number;
  results: NoteCase[];
}

// AND search: a case matches when every whitespace-separated term appears in its
// blob. `blobs[i]` must correspond to `cases[i]`. Results keep corpus order
// (already check_date-descending); only the first `limit` are materialized.
export function searchNotes(
  cases: NoteCase[],
  blobs: string[],
  query: string,
  filters: NoteFilters,
  limit: number,
): SearchResult {
  const terms = parseTerms(query);
  const results: NoteCase[] = [];
  let total = 0;
  for (let index = 0; index < cases.length; index += 1) {
    const record = cases[index];
    if (!matchesFilters(record, filters)) {
      continue;
    }
    const blob = blobs[index];
    let matched = true;
    for (const term of terms) {
      if (!blob.includes(term)) {
        matched = false;
        break;
      }
    }
    if (!matched) {
      continue;
    }
    total += 1;
    if (results.length < limit) {
      results.push(record);
    }
  }
  return { total, results };
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

// Split `text` into alternating plain / matched segments for <mark> rendering.
// Case-insensitive, multi-term; non-overlapping left-to-right.
export function highlightSegments(text: string, terms: string[]): HighlightSegment[] {
  const cleaned = terms.filter(Boolean);
  if (cleaned.length === 0) {
    return [{ text, hit: false }];
  }
  const escaped = cleaned.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), hit: false });
    }
    segments.push({ text: match[0], hit: true });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), hit: false });
  }
  return segments;
}
