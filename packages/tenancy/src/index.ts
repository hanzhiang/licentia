import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string | null;
  userId: string;
  actorType: string;
  requestId: string;
  bypassRls: boolean;
}

const als = new AsyncLocalStorage<TenantContext>();

export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return als.getStore();
}
