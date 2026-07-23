export const DETAIL_PAGE_SIZE = 100;

export type PageSlice<T> = {
  end: number;
  page: number;
  pageCount: number;
  rows: T[];
  start: number;
  total: number;
};

export function paginate<T>(items: readonly T[], requestedPage: number, pageSize = DETAIL_PAGE_SIZE): PageSlice<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error('pageSize must be a positive integer');
  }

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const normalizedPage = Number.isInteger(requestedPage) ? requestedPage : 1;
  const page = Math.min(Math.max(normalizedPage, 1), pageCount);
  const offset = (page - 1) * pageSize;

  return {
    end: Math.min(offset + pageSize, items.length),
    page,
    pageCount,
    rows: items.slice(offset, offset + pageSize),
    start: items.length === 0 ? 0 : offset + 1,
    total: items.length,
  };
}

export type PaginationItem = number | 'ellipsis';

export function getPaginationItems(currentPage: number, pageCount: number): PaginationItem[] {
  if (pageCount <= 7) {
    return Array.from({ length: Math.max(0, pageCount) }, (_, index) => index + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', pageCount];
  }
  if (currentPage >= pageCount - 3) {
    return [1, 'ellipsis', pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  }
  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', pageCount];
}
