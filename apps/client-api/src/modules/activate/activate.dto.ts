import { z } from 'zod';

export const ActivateSchema = z.object({
  code: z.string().min(4).max(64),
  app: z.object({
    product_code: z.string().min(1).max(64),
    version: z.string().min(1).max(32),
  }),
  device: z.object({
    fp_type: z.enum(['install_id', 'openid', 'unionid', 'machine_id', 'account']),
    fingerprint: z.string().min(8).max(256),
    platform: z.enum([
      'wechat_miniapp',
      'android',
      'ios',
      'web',
      'windows',
      'macos',
      'linux',
      'server',
    ]),
    meta: z.record(z.unknown()).optional(),
  }),
  // 组织许可的席位归属: user_id 仅用于席位 ZSET 成员(HMAC 后), 不落原文
  context: z.object({ user_id: z.string().min(1).max(128) }).optional(),
});

export type ActivateDto = z.infer<typeof ActivateSchema>;
