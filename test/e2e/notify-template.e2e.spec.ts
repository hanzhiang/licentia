/// <reference types="vitest" />
/**
 * 通知模板 e2e: 内置默认 → 租户覆盖 → 预览 → 恢复默认, 以及租户语言设置。
 * 前置: TEST_DATABASE_URL。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { createDb, withTenantTx, type LpDb } from '@lp/db';
import { NotifyTemplateService } from '../../apps/admin-api/src/modules/notifytemplate/notify-template.service';
import { TenantService } from '../../apps/admin-api/src/modules/tenant/tenant.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const TENANT = '11111111-1111-4111-8111-111111111111';
const actor = {
  userId: 'a1111111-0000-4000-8000-000000000002',
  actorType: 'developer_owner',
  ip: null,
  requestId: 'notify-template-e2e',
};

d.sequential('notification templates', () => {
  let db: Kysely<LpDb>;
  let templates: NotifyTemplateService;
  let tenants: TenantService;

  beforeAll(async () => {
    db = createDb(url!, { max: 3 });
    templates = new NotifyTemplateService(db);
    tenants = new TenantService(db);
    await withTenantTx(db, TENANT, (tx) =>
      tx.deleteFrom('notification_templates').where('tenant_id', '=', TENANT).execute(),
    );
  });

  afterAll(async () => {
    await withTenantTx(db, TENANT, (tx) =>
      tx.deleteFrom('notification_templates').where('tenant_id', '=', TENANT).execute(),
    );
    await withTenantTx(db, TENANT, (tx) =>
      tx.updateTable('tenants').set({ locale: 'zh-CN' }).where('id', '=', TENANT).execute(),
    );
    await db.destroy();
  });

  it('serves built-in defaults for both locales', async () => {
    const list = await templates.list(TENANT);
    const zh = list.find((t) => t.code === 'license_delivery' && t.locale === 'zh-CN')!;
    const en = list.find((t) => t.code === 'license_delivery' && t.locale === 'en')!;
    expect(zh.source).toBe('builtin');
    expect(en.subject).toContain('license code');
    // 每个模板两种语言都要在, 否则后台列表会缺行
    for (const code of ['email_verify', 'expire_warning_30d', 'license_batch_delivery']) {
      expect(list.some((t) => t.code === code && t.locale === 'en')).toBe(true);
    }
  });

  it('stores a tenant override and reports it as source=tenant', async () => {
    const saved = await templates.upsert(
      TENANT,
      'license_delivery',
      'zh-CN',
      {
        subject: '【{{product_name}}】授权码',
        body: '{{org_name}} 你好：\n\n你的授权码是 {{code}}。\n{{validity}}',
        sms_body: null,
      },
      actor,
    );
    expect(saved.source).toBe('tenant');
    expect(saved.subject).toBe('【{{product_name}}】授权码');

    const list = await templates.list(TENANT);
    const zh = list.find((t) => t.code === 'license_delivery' && t.locale === 'zh-CN')!;
    expect(zh.source).toBe('tenant');
    // 英文版没被改动, 仍然是内置默认
    const en = list.find((t) => t.code === 'license_delivery' && t.locale === 'en')!;
    expect(en.source).toBe('builtin');
  });

  it('previews the effective template with sample variables', async () => {
    const m = await templates.preview(TENANT, 'license_delivery', 'zh-CN', { code: 'DEMO-CODE' });
    expect(m.subject).toContain('授权码');
    expect(m.text).toContain('DEMO-CODE');
    expect(m.text).not.toContain('{{');
  });

  it('rejects placeholders that the template does not declare', async () => {
    await expect(
      templates.upsert(
        TENANT,
        'license_delivery',
        'zh-CN',
        { subject: 'x', body: '{{customer_name}}', sms_body: null },
        actor,
      ),
    ).rejects.toThrow(/未知变量/);
  });

  it('rejects unknown codes and locales', async () => {
    await expect(
      templates.upsert(TENANT, 'no_such', 'zh-CN', { subject: 's', body: 'b' }, actor),
    ).rejects.toThrow(/未知的模板码/);
    await expect(
      templates.upsert(TENANT, 'license_delivery', 'fr', { subject: 's', body: 'b' }, actor),
    ).rejects.toThrow(/不支持的语言/);
  });

  it('resets to the built-in default', async () => {
    await templates.reset(TENANT, 'license_delivery', 'zh-CN', actor);
    const list = await templates.list(TENANT);
    const zh = list.find((t) => t.code === 'license_delivery' && t.locale === 'zh-CN')!;
    expect(zh.source).toBe('builtin');
    expect(zh.body).toContain('{{code}}');
  });

  it('switches the tenant outbound-mail locale', async () => {
    const updated = await tenants.updateLocale(TENANT, 'en', actor);
    expect(updated.locale).toBe('en');
    expect((await tenants.get(TENANT)).locale).toBe('en');
    await tenants.updateLocale(TENANT, 'zh-CN', actor);
  });
});
