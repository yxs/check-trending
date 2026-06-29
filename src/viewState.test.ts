import { describe, expect, it } from 'vitest';

import { buildSearchFromViewState, readViewStateFromSearch } from './viewState';
import type { Filters } from './types';

const DEFAULT_FILTERS: Filters = {
  region: 'all',
  selectedDate: null,
  timeRangeDays: 'all',
  visaGroup: 'all',
  visaSubtype: 'all',
};

describe('view state URL parsing', () => {
  it('reads valid query params into filters', () => {
    const result = readViewStateFromSearch(
      '?vg=work&vs=h&r=Tokyo&t=180&s=2026-04-30',
      DEFAULT_FILTERS,
    );

    expect(result).toEqual({
      filters: {
        region: 'Tokyo',
        selectedDate: '2026-04-30',
        timeRangeDays: 180,
        visaGroup: 'work',
        visaSubtype: 'h',
      },
      detailStatus: 'all',
      detailSort: { key: 'clear', dir: 'desc' },
    });
  });

  it('falls back to defaults for invalid values', () => {
    const result = readViewStateFromSearch(
      '?vg=b&vs=h&d=invalid&n=whatever&r=&t=999&s=not-a-date',
      DEFAULT_FILTERS,
    );

    expect(result).toEqual({
      filters: {
        ...DEFAULT_FILTERS,
        visaGroup: 'b',
        visaSubtype: 'all',
      },
      detailStatus: 'all',
      detailSort: { key: 'clear', dir: 'desc' },
    });
  });
});

describe('view state URL serialization', () => {
  it('omits default values and keeps non-default state', () => {
    const search = buildSearchFromViewState(
      {
        ...DEFAULT_FILTERS,
        visaGroup: 'student',
        visaSubtype: 'f',
        region: 'Hong Kong',
        selectedDate: '2026-04-30',
      },
      DEFAULT_FILTERS,
    );

    expect(search).toBe('vg=student&vs=f&r=Hong+Kong&s=2026-04-30');
  });

  it('round-trips serialized filters', () => {
    const search = buildSearchFromViewState(
      {
        ...DEFAULT_FILTERS,
        region: 'Toronto',
        timeRangeDays: 365,
        visaGroup: 'work',
        visaSubtype: 'o',
      },
      DEFAULT_FILTERS,
    );

    const parsed = readViewStateFromSearch(search, DEFAULT_FILTERS);

    expect(parsed).toEqual({
      filters: {
        ...DEFAULT_FILTERS,
        region: 'Toronto',
        timeRangeDays: 365,
        visaGroup: 'work',
        visaSubtype: 'o',
      },
      detailStatus: 'all',
      detailSort: { key: 'clear', dir: 'desc' },
    });
  });

  it('round-trips detail status and sort in the URL', () => {
    const search = buildSearchFromViewState(DEFAULT_FILTERS, DEFAULT_FILTERS, 'over1y', { key: 'wait', dir: 'asc' });
    expect(search).toBe('ds=over1y&sort=wait-asc');

    const parsed = readViewStateFromSearch(search, DEFAULT_FILTERS);
    expect(parsed.detailStatus).toBe('over1y');
    expect(parsed.detailSort).toEqual({ key: 'wait', dir: 'asc' });
  });
});
