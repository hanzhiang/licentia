import { randomBytes } from 'node:crypto';

/** UUIDv7: 48bit 毫秒时间戳 + 随机, 时间有序便于索引与未来分库 */
export function uuidv7(now: number = Date.now()): string {
  const ts = Buffer.alloc(6);
  ts.writeUIntBE(now, 0, 6);
  const b = Buffer.concat([ts, randomBytes(10)]);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
