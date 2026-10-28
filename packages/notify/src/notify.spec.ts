import { describe, expect, it } from 'vitest';
import { ConsoleChannel } from './channels';
import { fail, ok } from './channel';
import { knownTemplates, renderTemplate } from './templates';

describe('notification templates', () => {
  it('renders all expire warning windows with the remaining days', () => {
    for (const days of [30, 7, 1]) {
      const m = renderTemplate(`expire_warning_${days}d`, {
        license_id: 'lic-1',
        due_in_days: days,
        expires_at: '2026-11-04T00:00:00.000Z',
        product_name: '宿舍查寝',
      });
      expect(m.subject).toContain(`${days} 天后到期`);
      expect(m.text).toContain('2026-11-04');
      expect(m.sms).toContain(`${days} 天后`);
      // 短信不得超长(网关普遍限制 70 字/条), 且不含标题
      expect(m.sms!.length).toBeLessThanOrEqual(70);
    }
  });

  it('rejects unknown template codes instead of sending a blank message', () => {
    expect(() => renderTemplate('no_such_template', { license_id: 'x' })).toThrow(
      'UNKNOWN_TEMPLATE',
    );
    expect(knownTemplates()).toContain('expire_warning_7d');
  });

  it('tolerates missing expiry and org name', () => {
    const m = renderTemplate('expire_warning_1d', { license_id: 'lic-2' });
    expect(m.text).toContain('未知');
    expect(m.text).not.toContain('undefined');
  });
});

describe('delivery result helpers', () => {
  it('captures error text and truncates long messages', () => {
    const r = fail(new Error('x'.repeat(1000)));
    expect(r.ok).toBe(false);
    expect(r.error!.length).toBe(300);
    expect(ok('m1')).toEqual({ ok: true, providerMessageId: 'm1', error: null });
  });
});

describe('console channel', () => {
  it('reports success with a synthetic provider id', async () => {
    const ch = new ConsoleChannel('email');
    const r = await ch.send({ to: 'a@b.c' }, { subject: 's', text: 't' });
    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toMatch(/^console-/);
  });
});
