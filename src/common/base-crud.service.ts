import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from './decorators/current-user.decorator';
import { contains, ListQuery, orderBy, pagination } from './utils/list-query';
import { scopedData, scopedWhere } from './utils/business-scope';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BaseCrudService {
  constructor(protected readonly prisma: PrismaService) {}

  protected delegate(model: string) {
    return (this.prisma as any)[model];
  }

  async listItems(options: {
    model: string;
    user: AuthUser;
    query: ListQuery;
    searchFields?: string[];
    filterFields?: string[];
    sortFields?: string[];
    include?: Record<string, unknown>;
    select?: Record<string, boolean | Record<string, unknown>>;
    businessScoped?: boolean;
  }) {
    const { page, take, skip } = pagination(options.query);
    const where: Record<string, unknown> = {};
    if (options.query.search && options.searchFields?.length) {
      where.OR = options.searchFields.map((field) => ({ [field]: contains(options.query.search) }));
    }
    for (const field of options.filterFields ?? []) {
      const value = options.query[field];
      if (value !== undefined && value !== '') where[field] = normalizeQueryValue(value);
    }
    const finalWhere = options.businessScoped === false ? where : scopedWhere(options.user, where);
    const [items, total] = await Promise.all([
      this.delegate(options.model).findMany({
        where: finalWhere,
        include: options.include,
        select: options.select,
        skip,
        take,
        orderBy: orderBy(options.query, options.sortFields ?? ['createdAt']),
      }),
      this.delegate(options.model).count({ where: finalWhere }),
    ]);
    return { items, meta: { page, take, total, pages: Math.ceil(total / take) } };
  }

  async get(model: string, user: AuthUser, id: string, include?: Record<string, unknown>, businessScoped = true, select?: Record<string, boolean | Record<string, unknown>>) {
    const item = await this.delegate(model).findFirst({
      where: businessScoped ? scopedWhere(user, { id }) : { id },
      include,
      select,
    });
    if (!item) throw new NotFoundException(`${model} not found`);
    return item;
  }

  async create(model: string, user: AuthUser, body: Record<string, unknown>, businessScoped = true) {
    return this.delegate(model).create({
      data: businessScoped ? scopedData(user, body) : body,
    });
  }

  async update(model: string, user: AuthUser, id: string, body: Record<string, unknown>, businessScoped = true) {
    await this.get(model, user, id, undefined, businessScoped);
    return this.delegate(model).update({ where: { id }, data: body });
  }

  async remove(model: string, user: AuthUser, id: string, businessScoped = true) {
    await this.get(model, user, id, undefined, businessScoped);
    return this.delegate(model).delete({ where: { id } });
  }
}

function normalizeQueryValue(value: unknown) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return value;
}
