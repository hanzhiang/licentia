import { Controller, Get } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { LicenseSigner } from '@lp/signer';
import { SIGNER } from './signer.module';

/** JWKS 公钥分发: SDK 内置快照 + 此端点在线刷新(设计文档 §10.1) */
@Controller()
export class JwksController {
  constructor(@Inject(SIGNER) private readonly signer: LicenseSigner) {}

  @Get('.well-known/jwks.json')
  async jwks(): Promise<{ keys: Record<string, string>[] }> {
    // 当前钥 + 并行验证期旧钥(双 kid 轮换窗口, 设计文档 §10.2)
    return this.signer.publicJwks();
  }
}
