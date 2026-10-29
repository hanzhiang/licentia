export * from './metrics';
export * from './csv';
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AppError } from '@lp/domain';

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
}

function asPgError(e: unknown): PgLikeError | null {
  if (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as PgLikeError).code === 'string' &&
    (e as PgLikeError).code!.match(/^23/) // 完整性约束类
  ) {
    return e as PgLikeError;
  }
  return null;
}

/**
 * 统一错误出口: { error: { code, message, details, request_id } }.
 * 未知异常一律收敛为 INTERNAL_ERROR(500) 且不外泄堆栈.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let e: AppError;
    if (exception instanceof AppError) {
      e = exception;
    } else {
      const pg = asPgError(exception);
      if (pg?.code === '23505') {
        // 唯一约束冲突: 在业务未显式处理的路径上按幂等冲突收敛
        e = new AppError('IDEMPOTENCY_CONFLICT', `duplicate resource: ${pg.constraint ?? 'unknown'}`);
      } else {
        console.error('[unhandled]', exception);
        e = new AppError('INTERNAL_ERROR');
      }
    }
    const requestId = (reply.request as { id?: string | number } | undefined)?.id;
    void reply.code(e.http).send({
      error: {
        code: e.code,
        message: e.message,
        details: e.details ?? {},
        request_id: requestId != null ? String(requestId) : null,
      },
    });
  }
}
