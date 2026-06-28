import { getRegionGroup, getVisaGroup } from './analytics';
import type { VisaGroup } from './types';

export interface NoteCase {
  cn: string;
  id: string;
  vt: string;
  ve: string;
  co: string;
  mj: string;
  st: string;
  cd: string;
  cp: string | null;
  wd: number | null;
  nt: string;
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
  year: string;
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

export function buildSearchBlob(record: NoteCase): string {
  return [record.nt, record.mj, record.co, record.vt, record.ve, record.id, record.st]
    .join('  ')
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
  matches: NoteCase[];
}

export function searchNotes(
  cases: NoteCase[],
  blobs: string[],
  query: string,
  filters: NoteFilters,
): SearchResult {
  const terms = parseTerms(query);
  const matches: NoteCase[] = [];
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
    if (matched) {
      matches.push(record);
    }
  }
  return { total: matches.length, matches };
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

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
