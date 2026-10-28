/// <reference types="vitest" />
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import {
  backupDirName,
  buildRolesSql,
  verifyAuditChains,
  verifyBackup,
  type BackupManifest,
} from './backup';

const url = process.env.TEST_DATABASE_URL;
const dbDescribe = url ? describe : describe.skip;

function makeManifest(files: Record<string, { bytes: number; sha256: string }>): BackupManifest {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    database: 'lp',
    pgVersion: '16',
    migrations: ['0001_init.sql'],
    rowCounts: {},
    appGrants: 1,
    databaseSizeBytes: 1,
    files,
  };
}

describe('backup verification (local files)', () => {
  it('exports login role attributes and the SCRAM password hash', () => {
    const sql = buildRolesSql(
      [
        'lp_app\tt\tf\tf\t-1\tSCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk',
        'postgres\tt\tf\tt\t-1\tSCRAM-SHA-256$4096:skip$skip',
      ].join('\n'),
    );
    expect(sql).toContain('create role "lp_app" LOGIN NOBYPASSRLS NOSUPERUSER');
    expect(sql).toContain(
      "alter role \"lp_app\" password 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk';",
    );
    expect(sql).not.toContain('"postgres"');
  });

  it('quotes role names and password hashes safely', () => {
    const sql = buildRolesSql(`role"x\tt\tf\tf\t-1\tpa'ss`);
    expect(sql).toContain('create role "role""x"');
    expect(sql).toContain("password 'pa''ss'");
  });

  it('never writes the masked pg_roles password into recovery SQL', () => {
    const sql = buildRolesSql('lp_app\tt\tf\tf\t-1\t********');
    expect(sql).not.toContain('password');
  });

  it('detects a tampered dump even when the file size is unchanged', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-backup-test-'));
    try {
      const bytes = Buffer.from('dump-content');
      fs.writeFileSync(path.join(dir, 'database.dump'), bytes);
      fs.writeFileSync(path.join(dir, 'roles.sql'), '');
      const manifest = makeManifest({
        'database.dump': {
          bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
        'roles.sql': {
          bytes: 0,
          sha256: crypto.createHash('sha256').update('').digest('hex'),
        },
      });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

      await expect(verifyBackup(dir)).resolves.toMatchObject({ ok: true });

      const tampered = Buffer.from(bytes);
      tampered[0] ^= 0xff;
      fs.writeFileSync(path.join(dir, 'database.dump'), tampered);
      const result = await verifyBackup(dir);
      expect(result.ok).toBe(false);
      expect(result.problems).toContain('database.dump sha256 不符');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates a sortable timestamped directory name', () => {
    const name = backupDirName('/backups', new Date('2026-10-28T09:17:46.237Z'));
    expect(name).toBe(path.join('/backups', 'backup-2026-10-28T09-17-46-237'));
  });
});

dbDescribe.sequential('audit chain verification', () => {
  let db: Kysely<LpDb>;

  beforeAll(() => {
    db = createDb(url!, { max: 5 });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('accepts the live chain and detects a tampered row inside a rolled-back transaction', async () => {
    const live = await withSystemTx(db, (tx) => verifyAuditChains(tx));
    expect(live.ok).toBe(true);
    expect(live.checked).toBeGreaterThan(0);

    const row = await withSystemTx(db, (tx) =>
      tx
        .selectFrom('audit_events')
        .select(['id', 'tenant_id'])
        .orderBy('id')
        .limit(1)
        .executeTakeFirstOrThrow(),
    );

    // 篡改后在同事务内验链, 再抛错回滚: 验证检测能力但不污染开发库.
    await expect(
      withSystemTx(db, async (tx) => {
        await sql`
          update audit_events
             set detail = jsonb_set(detail, '{tampered}', 'true'::jsonb)
           where id = ${row.id}
        `.execute(tx);
        const tampered = await verifyAuditChains(tx);
        expect(tampered.ok).toBe(false);
        expect(tampered.chains.some((c) => !c.valid)).toBe(true);
        throw new Error('rollback-test-tamper');
      }),
    ).rejects.toThrow('rollback-test-tamper');

    const afterRollback = await withSystemTx(db, (tx) => verifyAuditChains(tx));
    expect(afterRollback.ok).toBe(true);
    expect(afterRollback.checked).toBe(live.checked);
  });
});
