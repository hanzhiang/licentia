/** SDK 错误: code 与平台错误码目录一致(设计文档 §13.1) */
export class SdkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SdkError';
  }
}

export function httpStatusFor(code: string): number {
  const map: Record<string, number> = {
    AUTH_REQUIRED: 401,
    PERM_DENIED: 403,
    REQ_INVALID: 400,
    LIC_NOT_FOUND: 404,
    LIC_CODE_MALFORMED: 400,
    LIC_STATUS_INVALID: 409,
    LIC_DEVICE_LIMIT_REACHED: 409,
    LIC_EXPIRED: 410,
    LIC_REVOKED: 410,
    LIC_SUSPENDED: 423,
    LIC_PRODUCT_MISMATCH: 400,
    LIC_VERSION_TOO_LOW: 400,
    RATE_LIMITED: 429,
    IDEMPOTENCY_CONFLICT: 409,
    DEPENDENCY_UNAVAILABLE: 503,
    INTERNAL_ERROR: 500,
  };
  return map[code] ?? 500;
}
