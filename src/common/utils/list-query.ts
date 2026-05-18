export type ListQuery = {
  page?: string | number;
  limit?: string | number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  [key: string]: unknown;
};

export function pagination(query: ListQuery) {
  const page = Math.max(Number(query.page ?? 1), 1);
  const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function orderBy(query: ListQuery, allowed: string[], fallback = 'createdAt') {
  const sortBy = allowed.includes(String(query.sortBy)) ? String(query.sortBy) : fallback;
  const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';
  return { [sortBy]: sortOrder };
}

export function contains(search: unknown) {
  return { contains: String(search), mode: 'insensitive' };
}

export function dateRange(from?: unknown, to?: unknown) {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(String(from)) } : {}),
    ...(to ? { lte: new Date(String(to)) } : {}),
  };
}

export function toMoney(value: unknown) {
  return Number(value ?? 0);
}
