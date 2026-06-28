import { describe, expect, it } from 'vitest';

import {
  buildSearchBlob,
  highlightSegments,
  noteYear,
  parseTerms,
  searchNotes,
} from './notes';
import type { NoteCase, NoteFilters } from './notes';
import { DEFAULT_NOTE_FILTERS } from './notes';

function makeCase(overrides: Partial<NoteCase>): NoteCase {
  return {
    cn: '1',
    id: 'tester',
    vt: 'F1',
    ve: 'New',
    co: 'BeiJing',
    mj: 'Physics',
    st: 'Clear',
    cd: '2024-05-01',
    cp: '2024-06-01',
    wd: 31,
    nt: 'social media check then approved',
    ...overrides,
  };
}

function withBlobs(cases: NoteCase[]): string[] {
  return cases.map(buildSearchBlob);
}

describe('parseTerms', () => {
  it('lowercases and splits on whitespace, dropping empties', () => {
    expect(parseTerms('  Social   Media ')).toEqual(['social', 'media']);
    expect(parseTerms('')).toEqual([]);
  });
});

describe('buildSearchBlob', () => {
  it('includes note plus searchable metadata, lowercased', () => {
    const blob = buildSearchBlob(makeCase({ nt: 'AP then 补料', mj: 'Aerospace', co: 'ShangHai' }));
    expect(blob).toContain('ap then 补料');
    expect(blob).toContain('aerospace');
    expect(blob).toContain('shanghai');
    expect(blob).toContain('f1');
  });
});

describe('noteYear', () => {
  it('takes the year from the check date', () => {
    expect(noteYear(makeCase({ cd: '2019-11-20' }))).toBe('2019');
  });
});

describe('searchNotes', () => {
  const cases = [
    makeCase({ cn: '1', nt: 'social media check, then approved', st: 'Clear', cd: '2024-05-01', vt: 'F1' }),
    makeCase({ cn: '2', nt: '行政审查 补料 四件套', st: 'Pending', cd: '2023-09-02', vt: 'H1', co: 'HongKong' }),
    makeCase({ cn: '3', nt: 'approved fast, no check', st: 'Clear', cd: '2024-02-10', vt: 'B1' }),
  ];
  const blobs = withBlobs(cases);

  it('returns all cases (filtered) for an empty query', () => {
    const out = searchNotes(cases, blobs, '', DEFAULT_NOTE_FILTERS, 100);
    expect(out.total).toBe(3);
    expect(out.results).toHaveLength(3);
  });

  it('AND-matches every term against the blob', () => {
    const out = searchNotes(cases, blobs, 'social approved', DEFAULT_NOTE_FILTERS, 100);
    expect(out.results.map((record) => record.cn)).toEqual(['1']);
  });

  it('matches CJK keywords', () => {
    const out = searchNotes(cases, blobs, '补料', DEFAULT_NOTE_FILTERS, 100);
    expect(out.results.map((record) => record.cn)).toEqual(['2']);
  });

  it('applies the status filter', () => {
    const filters: NoteFilters = { ...DEFAULT_NOTE_FILTERS, status: 'Pending' };
    const out = searchNotes(cases, blobs, '', filters, 100);
    expect(out.results.map((record) => record.cn)).toEqual(['2']);
  });

  it('applies the visa-group filter', () => {
    const filters: NoteFilters = { ...DEFAULT_NOTE_FILTERS, visaGroup: 'work' };
    const out = searchNotes(cases, blobs, '', filters, 100);
    expect(out.results.map((record) => record.cn)).toEqual(['2']);
  });

  it('applies the year filter', () => {
    const filters: NoteFilters = { ...DEFAULT_NOTE_FILTERS, year: '2024' };
    const out = searchNotes(cases, blobs, '', filters, 100);
    expect(out.results.map((record) => record.cn).sort()).toEqual(['1', '3']);
  });

  it('applies the region filter (overseas)', () => {
    const filters: NoteFilters = { ...DEFAULT_NOTE_FILTERS, region: 'overseas' };
    const out = searchNotes(cases, blobs, '', filters, 100);
    expect(out.results.map((record) => record.cn)).toEqual(['2']);
  });

  it('reports total beyond the render limit but caps the results array', () => {
    const out = searchNotes(cases, blobs, '', DEFAULT_NOTE_FILTERS, 2);
    expect(out.total).toBe(3);
    expect(out.results).toHaveLength(2);
  });
});

describe('highlightSegments', () => {
  it('returns a single plain segment when there are no terms', () => {
    expect(highlightSegments('hello world', [])).toEqual([{ text: 'hello world', hit: false }]);
  });

  it('marks matched terms case-insensitively', () => {
    const segments = highlightSegments('Social media CHECK', ['check']);
    expect(segments).toEqual([
      { text: 'Social media ', hit: false },
      { text: 'CHECK', hit: true },
    ]);
  });

  it('handles multiple terms and preserves surrounding text', () => {
    const segments = highlightSegments('a AP b 补料 c', ['ap', '补料']);
    expect(segments.filter((segment) => segment.hit).map((segment) => segment.text)).toEqual(['AP', '补料']);
    expect(segments.map((segment) => segment.text).join('')).toBe('a AP b 补料 c');
  });

  it('escapes regex metacharacters in terms', () => {
    const segments = highlightSegments('cost is $5 (approx)', ['$5', '(approx)']);
    expect(segments.filter((segment) => segment.hit).map((segment) => segment.text)).toEqual(['$5', '(approx)']);
  });
});
