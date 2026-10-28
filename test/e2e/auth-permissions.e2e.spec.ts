/// <reference types="vitest" />
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withSystemTx, type LpDb } from '@lp/db';
import { AuthService } from '../../apps/admin-api/src/modules/auth/auth.service';
import { RbacService } from '../../apps/admin-api/src/iam/iam.module';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d.sequential('auth permission projection e2e', () => {
  let db: Kysely<LpDb>;
  let auth: AuthService;
  const tokenHashes: Buffer[] = [];

  beforeAll(() => {
    db = createDb(url!, { max: 5 });
    auth = new AuthService(db, new RbacService(db, null), null);
  });

  afterAll(async () => {
    if (tokenHashes.length > 0) {
      await withSystemTx(db, (tx) =>
        tx.deleteFrom('refresh_tokens').where('token_hash', 'in', tokenHashes).execute(),
      );
    }
    await db.destroy();
  });

  it('returns the effective permission set on login, refresh and profile', async () => {
    const admin = await auth.login('admin@demo.local', 'Passw0rd!demo', '127.0.0.1');
    const operator = await auth.login('operator@demo.local', 'Passw0rd!demo', '127.0.0.1');
    tokenHashes.push(
      crypto.createHash('sha256').update(admin.refresh_token, 'utf8').digest(),
      crypto.createHash('sha256').update(operator.refresh_token, 'utf8').digest(),
    );

    expect(admin.user.permissions).toEqual(
      expect.arrayContaining(['product:write', 'policy:write', 'webhook:write']),
    );
    expect(operator.user.permissions).not.toContain('product:write');
    expect(operator.user.permissions).toEqual(
      expect.arrayContaining(['license:issue', 'license:renew', 'end_customer:write']),
    );

    const profile = await auth.profile(operator.user.id);
    expect(profile.user.permissions).toEqual(operator.user.permissions);

    const refreshed = await auth.refresh(operator.refresh_token, '127.0.0.1');
    tokenHashes.push(
      crypto.createHash('sha256').update(refreshed.refresh_token, 'utf8').digest(),
    );
    expect(refreshed.user.permissions).toEqual(operator.user.permissions);
  });
});
