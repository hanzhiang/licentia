import type { Generated } from 'kysely';
import type { LicenseStatus } from '@lp/domain';

/** notifications_outbox 投递状态(0005 迁移扩展) */
export type NotificationStatus =
  | 'pending'
  | 'retrying'
  | 'sent'
  | 'failed'
  | 'dead'
  | 'blocked';

export interface TenantsRow {
  id: string;
  code: string;
  name: string;
  status: string;
  plan: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ProductsRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface PoliciesRow {
  id: string;
  tenant_id: string;
  product_id: string;
  code: string;
  name: string;
  kind: string;
  duration_days: number | null;
  device_limit: number;
  seat_limit: number | null;
  concurrency_limit: number | null;
  features: string[];
  offline_window_days: number;
  heartbeat_hours: number;
  grace_hours: number;
  activate_within_days: number;
  allow_renewal: boolean;
  renew_window_days: number;
  min_version: string | null;
  status: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ChannelsRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  status: string;
  created_at: Date;
  deleted_at: Date | null;
}

export interface LicenseBatchesRow {
  id: string;
  tenant_id: string;
  product_id: string;
  policy_id: string;
  channel_id: string | null;
  code: string;
  quantity: number;
  status: 'pending' | 'issuing' | 'completed' | 'failed' | 'partially_failed';
  issued_count: number;
  failed_count: number;
  note: string | null;
  csv_object_key: string | null;
  created_by: string;
  created_at: Date;
  completed_at: Date | null;
}

export interface LicensesRow {
  id: string;
  tenant_id: string;
  product_id: string;
  policy_id: string;
  batch_id: string | null;
  channel_id: string | null;
  end_customer_id: string | null;
  code: string;
  code_hmac: Buffer;
  code_cipher: Buffer;
  kind: string;
  status: LicenseStatus;
  device_limit: number;
  seat_limit: number | null;
  concurrency_limit: number | null;
  features: string[];
  offline_window_days: number;
  heartbeat_hours: number;
  grace_hours: number;
  activate_within_days: number;
  renew_window_days: number;
  allow_renewal: boolean;
  min_version: string | null;
  duration_days: number | null;
  issued_at: Date;
  activated_at: Date | null;
  expires_at: Date | null;
  suspended_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface DevicesRow {
  id: string;
  tenant_id: string;
  product_id: string;
  fp_type: string;
  fingerprint: Buffer;
  platform: string;
  display_name: string | null;
  meta: Record<string, unknown>;
  blocked: boolean;
  first_seen_at: Date;
  last_seen_at: Date | null;
}

export interface LicenseActivationsRow {
  id: string;
  tenant_id: string;
  license_id: string;
  device_id: string | null;
  end_customer_id: string | null;
  status: 'active' | 'released';
  activated_at: Date;
  released_at: Date | null;
  released_by: string | null;
  released_reason: string | null;
  last_seen_at: Date | null;
  client_meta: Record<string, unknown>;
}

export interface ClientTokensRow {
  token_hash: Buffer;
  activation_id: string;
  license_id: string;
  tenant_id: string;
  expires_at: Date;
  created_at: Date;
}

export interface RenewalsRow {
  id: string;
  tenant_id: string;
  license_id: string;
  days: number;
  old_expires_at: Date | null;
  new_expires_at: Date;
  order_ref: string | null;
  source: string;
  operator_id: string | null;
  idem_key: string | null;
  created_at: Date;
}

export interface EventsRow {
  id: string;
  tenant_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
}

export interface IdempotencyKeysRow {
  tenant_id: string;
  idem_key: string;
  endpoint: string;
  request_hash: Buffer;
  status: 'processing' | 'completed' | 'failed';
  http_status: number | null;
  response: Record<string, unknown> | null;
  locked_at: Date;
  expires_at: Date;
}

export interface UsersRow {
  id: string;
  tenant_id: string | null;
  email: string;
  phone_hash: Buffer | null;
  password_hash: string | null;
  status: string;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface RolesRow {
  id: string;
  code: string;
  name: string;
}

export interface RolePermissionsRow {
  role_code: string;
  perm: string;
}

export interface UserRolesRow {
  user_id: string;
  role_code: string;
}

export interface RefreshTokensRow {
  id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  ip: string | null;
  ua: string | null;
}

export interface ApiKeysRow {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  key_hash: Buffer;
  scopes: string[];
  rate_limit_qps: number;
  ip_allowlist: string[];
  status: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  rotated_from_id: string | null;
  created_by: string;
  created_at: Date;
}

export interface WebhookEndpointsRow {
  id: string;
  tenant_id: string;
  url: string;
  secret_cipher: Buffer;
  events: string[];
  status: string;
  concurrency: number;
  failure_count: number;
  disabled_until: Date | null;
  created_at: Date;
  deleted_at: Date | null;
}

export interface WebhookDeliveriesRow {
  id: Generated<string>;
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt: number;
  status: string;
  next_retry_at: Date | null;
  response_status: number | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuditEventsRow {
  id: Generated<string>;
  tenant_id: string | null;
  occurred_at: Date;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  detail: Record<string, unknown>;
  ip: string | null;
  ua: string | null;
  request_id: string | null;
  prev_hash: Buffer;
  entry_hash: Buffer;
}

export interface EndCustomersRow {
  id: string;
  tenant_id: string;
  name: string;
  type: string;
  contact_phone_hash: Buffer | null;
  contact_email_enc: Buffer | null;
  status: string;
  created_at: Date;
  deleted_at: Date | null;
}

/** v_channel_batch_stats 视图(count 返回 bigint → pg 为 string) */
export interface VChannelBatchStatsRow {
  tenant_id: string;
  batch_id: string;
  channel_id: string | null;
  quantity: number;
  activated_count: string;
  active_license_count: string;
  revoked_count: string;
  activation_rate_pct: string;
}

export interface NotificationsOutboxRow {
  id: string;
  tenant_id: string;
  license_id: string | null;
  channel: string;
  template_code: string;
  to_addr_enc: Buffer | null;
  payload: Record<string, unknown>;
  scheduled_for: string; // date 列 → pg 返回 'YYYY-MM-DD'
  status: NotificationStatus;
  retries: number;
  last_error: string | null;
  created_at: Date;
  sent_at: Date | null;
  provider_message_id: string | null;
  next_retry_at: Date | null;
  updated_at: Date;
}

export interface LpDb {
  tenants: TenantsRow;
  users: UsersRow;
  roles: RolesRow;
  role_permissions: RolePermissionsRow;
  user_roles: UserRolesRow;
  products: ProductsRow;
  policies: PoliciesRow;
  channels: ChannelsRow;
  license_batches: LicenseBatchesRow;
  licenses: LicensesRow;
  devices: DevicesRow;
  license_activations: LicenseActivationsRow;
  client_tokens: ClientTokensRow;
  refresh_tokens: RefreshTokensRow;
  end_customers: EndCustomersRow;
  renewals: RenewalsRow;
  events: EventsRow;
  idempotency_keys: IdempotencyKeysRow;
  api_keys: ApiKeysRow;
  notifications_outbox: NotificationsOutboxRow;
  webhook_endpoints: WebhookEndpointsRow;
  webhook_deliveries: WebhookDeliveriesRow;
  audit_events: AuditEventsRow;
  v_channel_batch_stats: VChannelBatchStatsRow;
}
