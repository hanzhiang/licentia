/** 进程内 TTL 缓存(骨架: validate 缓存 60s; P3 换 Redis + 事件主动失效, 见设计 §4.7) */
export class TtlCache<V> {
  private readonly m = new Map<string, { v: V; exp: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e.v;
  }

  set(key: string, value: V): void {
    this.m.set(key, { v: value, exp: Date.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.m.delete(key);
  }
}
