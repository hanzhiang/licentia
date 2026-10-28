import { z } from 'zod';

export const IssueBatchSchema = z.object({
  product_id: z.string().uuid(),
  policy_id: z.string().uuid(),
  channel_id: z.string().uuid().nullish(),
  quantity: z.number().int().min(1),
  note: z.string().max(200).nullish(),
});

export type IssueBatchDto = z.infer<typeof IssueBatchSchema>;

export const RenewSchema = z.object({
  days: z.number().int().min(1).max(36500),
  order_ref: z.string().min(1).max(128).nullish(),
});

export type RenewDto = z.infer<typeof RenewSchema>;

export const RevokeSchema = z.object({
  reason: z.string().min(1).max(200),
});

export type RevokeDto = z.infer<typeof RevokeSchema>;
