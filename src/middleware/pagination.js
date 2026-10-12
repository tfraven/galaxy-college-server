const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export const getPagination = (query) => {
  const requestedPage = Number.parseInt(query.page, 10);
  const requestedSize = Number.parseInt(query.pageSize, 10);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = Number.isSafeInteger(requestedSize) && requestedSize > 0
    ? Math.min(requestedSize, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  return { page, pageSize, offset: (page - 1) * pageSize };
};

export const paginationMeta = (total, { page, pageSize }) => ({
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});
