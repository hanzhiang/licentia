/**
 * 统一错误码目录与 AppError.
 * 约定: code 是对外稳定契约, message 仅用于人读; http 为 HTTP 状态码.
 * 防探测: 客户端 API 对"码不存在"与"已吊销"都使用 AppError, 响应耗时差异由调用方(网关)拉平.
 */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'PERM_DENIED'
  | 'REQ_INVALID'
  | 'API_KEY_INVALID'
  | 'API_KEY_SCOPE_DENIED'
  | 'TENANT_SUSPENDED'
  | 'LIC_NOT_FOUND'
  | 'LIC_CODE_MALFORMED'
  | 'LIC_STATUS_INVALID'
  | 'LIC_DEVICE_LIMIT_REACHED'
  | 'LIC_EXPIRED'
  | 'LIC_REVOKED'
  | 'LIC_SUSPENDED'
  | 'LIC_PRODUCT_MISMATCH'
  | 'LIC_VERSION_TOO_LOW'
  | 'LIC_NOT_RENEWABLE'
  | 'LIC_RENEW_WINDOW_EXCEEDED'
  | 'SEAT_CONCURRENCY_LIMIT'
  | 'RELEASE_QUOTA_EXCEEDED'
  | 'BATCH_QUOTA_EXCEEDED'
  | 'BATCH_TOO_LARGE'
  | 'BATCH_NOT_FOUND'
  | 'POLICY_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ErrorMeta {
  http: number;
  message: string;
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorMeta> = {
  AUTH_REQUIRED: { http: 401, message: '未认证或凭证已过期' },
  PERM_DENIED: { http: 403, message: '无权限执行该操作' },
  REQ_INVALID: { http: 400, message: '请求参数不合法' },
  API_KEY_INVALID: { http: 401, message: 'API Key 无效或已吊销' },
  API_KEY_SCOPE_DENIED: { http: 403, message: 'API Key 权限范围不足' },
  TENANT_SUSPENDED: { http: 403, message: '租户已停用' },
  LIC_NOT_FOUND: { http: 404, message: '授权码不存在' },
  LIC_CODE_MALFORMED: { http: 400, message: '授权码格式错误' },
  LIC_STATUS_INVALID: { http: 409, message: '授权码状态不允许该操作' },
  LIC_DEVICE_LIMIT_REACHED: { http: 409, message: '设备数已达上限, 请先解绑设备' },
  LIC_EXPIRED: { http: 410, message: '授权已过期' },
  LIC_REVOKED: { http: 410, message: '授权已被吊销' },
  LIC_SUSPENDED: { http: 423, message: '授权已被暂停' },
  LIC_PRODUCT_MISMATCH: { http: 400, message: '授权码与产品不匹配' },
  LIC_VERSION_TOO_LOW: { http: 400, message: '客户端版本低于策略要求' },
  LIC_NOT_RENEWABLE: { http: 409, message: '该授权不可续期' },
  LIC_RENEW_WINDOW_EXCEEDED: { http: 409, message: '已超出续期窗口, 需运营特批' },
  SEAT_CONCURRENCY_LIMIT: { http: 429, message: '并发/席位已达上限' },
  RELEASE_QUOTA_EXCEEDED: { http: 429, message: '解绑次数超出配额' },
  BATCH_QUOTA_EXCEEDED: { http: 409, message: '发码余量不足' },
  BATCH_TOO_LARGE: { http: 413, message: '单批数量超出上限' },
  BATCH_NOT_FOUND: { http: 404, message: '批次不存在' },
  POLICY_NOT_FOUND: { http: 404, message: '策略不存在' },
  PRODUCT_NOT_FOUND: { http: 404, message: '产品不存在' },
  RATE_LIMITED: { http: 429, message: '请求过于频繁' },
  IDEMPOTENCY_KEY_REQUIRED: { http: 400, message: '缺少 Idempotency-Key 头' },
  IDEMPOTENCY_CONFLICT: { http: 409, message: '幂等键已被不同请求使用' },
  IDEMPOTENCY_IN_PROGRESS: { http: 409, message: '相同幂等键的请求正在处理中, 请稍后重试' },
  DEPENDENCY_UNAVAILABLE: { http: 503, message: '依赖服务暂不可用' },
  INTERNAL_ERROR: { http: 500, message: '内部错误' },
};

export class AppError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_CATALOG[code].message);
    this.name = 'AppError';
    this.details = details;
  }

  get http(): number {
    return ERROR_CATALOG[this.code].http;
  }
}

// ---- 常用快捷构造 ----
export const errAuthRequired = (m?: string) => new AppError('AUTH_REQUIRED', m);
export const errPermDenied = (m?: string) => new AppError('PERM_DENIED', m);
export const errReqInvalid = (m?: string, details?: Record<string, unknown>) =>
  new AppError('REQ_INVALID', m, details);
export const errLicNotFound = () => new AppError('LIC_NOT_FOUND');
export const errLicMalformed = (m?: string) => new AppError('LIC_CODE_MALFORMED', m);
export const errStatusInvalid = (m?: string) => new AppError('LIC_STATUS_INVALID', m);
export const errDeviceLimit = () => new AppError('LIC_DEVICE_LIMIT_REACHED');
export const errLicExpired = () => new AppError('LIC_EXPIRED');
export const errLicRevoked = () => new AppError('LIC_REVOKED');
export const errLicSuspended = () => new AppError('LIC_SUSPENDED');
export const errProductMismatch = () => new AppError('LIC_PRODUCT_MISMATCH');
export const errVersionTooLow = () => new AppError('LIC_VERSION_TOO_LOW');
export const errNotRenewable = () => new AppError('LIC_NOT_RENEWABLE');
export const errRenewWindow = () => new AppError('LIC_RENEW_WINDOW_EXCEEDED');
export const errIdempotencyKeyRequired = () => new AppError('IDEMPOTENCY_KEY_REQUIRED');
export const errIdempotencyConflict = (m?: string) => new AppError('IDEMPOTENCY_CONFLICT', m);
export const errIdempotencyInProgress = () => new AppError('IDEMPOTENCY_IN_PROGRESS');
export const errBatchTooLarge = (m?: string) => new AppError('BATCH_TOO_LARGE', m);
export const errBatchNotFound = () => new AppError('BATCH_NOT_FOUND');
export const errPolicyNotFound = () => new AppError('POLICY_NOT_FOUND');
export const errProductNotFound = () => new AppError('PRODUCT_NOT_FOUND');
export const errInternal = (m?: string) => new AppError('INTERNAL_ERROR', m);
