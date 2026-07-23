import { describe, expect, it } from 'vitest';

import { getPaginationItems, paginate } from './pagination';

describe('detail pagination', () => {
  const rows = Array.from({ length: 205 }, (_, index) => index + 1);

  it('returns 100 rows per page and keeps the final partial page', () => {
    expect(paginate(rows, 1)).toMatchObject({
      page: 1,
      pageCount: 3,
      start: 1,
      end: 100,
      total: 205,
    });
    expect(paginate(rows, 2).rows).toEqual(rows.slice(100, 200));
    expect(paginate(rows, 3)).toMatchObject({
      page: 3,
      start: 201,
      end: 205,
      rows: rows.slice(200),
    });
  });

  it('clamps an out-of-range page after the result set shrinks', () => {
    expect(paginate(rows, 99).page).toBe(3);
    expect(paginate([], 4)).toMatchObject({ page: 1, pageCount: 1, start: 0, end: 0, rows: [] });
  });

  it('builds compact page links around the current page', () => {
    expect(getPaginationItems(1, 10)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 10]);
    expect(getPaginationItems(6, 10)).toEqual([1, 'ellipsis', 5, 6, 7, 'ellipsis', 10]);
    expect(getPaginationItems(10, 10)).toEqual([1, 'ellipsis', 6, 7, 8, 9, 10]);
  });
});
