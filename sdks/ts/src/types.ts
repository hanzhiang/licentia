export type FpType = 'install_id' | 'openid' | 'unionid' | 'machine_id' | 'account';
export type Platform =
  | 'wechat_miniapp'
  | 'android'
  | 'ios'
  | 'web'
  | 'windows'
  | 'macos'
  | 'linux'
  | 'server';

export interface DeviceInfo {
  fpType: FpType;
  fingerprint: string;
  platform: Platform;
  meta?: Record<string, unknown>;
}

export interface ActivateResult {
  client_token: string;
  expires_at: string | null;
  license: {
    id: string;
    kind: string;
    status: string;
    features: string[];
    device: { bound: number; limit: number };
    offline_window_days: number;
    heartbeat_hours: number;
  };
  offline_license: string | null;
  server_time: number;
  replayed?: boolean;
}

export interface HeartbeatResult {
  status: string;
  features: string[];
  expires_at: string | null;
  client_token: string;
  offline_license: string | null;
  server_time: number;
}

export interface Entitlement {
  valid: boolean;
  reason?: string;
  features: string[];
  expiresAt: string | null;
  source: 'server' | 'offline';
  serverTime: number;
}

export interface Jwk {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  use?: string;
  alg?: string;
  [key: string]: unknown;
}

export interface OfflineLicenseClaims {
  jti: string;
  lic: string;
  tnt: string;
  prd: string;
  feats: string[];
  dev?: string;
  seat?: number;
  conc?: number;
  olw: number;
  iat: number;
  exp: number;
}
