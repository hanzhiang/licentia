/**
 * 密钥轮换 CLI(设计文档 §10.2 双密钥并行验证窗).
 * 用法: pnpm key:rotate -- --old-kid dev-2026-01 --old-seed <旧种子>
 * 输出: 新 kid/种子 + 需要设置的环境变量(旧钥降级为仅验签 60 天).
 */
import crypto from 'node:crypto';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const oldKid = arg('--old-kid') ?? 'dev-2026-01';
const oldSeed = arg('--old-seed');

const stamp = new Date().toISOString().slice(0, 7); // kid 按月: <product>-<YYYY-MM>
const newKid = `${oldKid.split('-').slice(0, -2).join('-') || 'prod'}-${stamp}`;
const newSeed = crypto.randomBytes(32).toString('base64url');

console.log('==== 密钥轮换计划(双密钥并行验证窗 60 天) ====');
console.log(`
# 1. 设置以下环境变量并滚动重启(签名立即切新钥, 旧钥保留验签 ${60} 天):
SIGNER_ACTIVE_KID=${newKid}
SIGNER_LOCAL_SEED=${newSeed}
SIGNER_PREVIOUS_KID=${oldKid}
${oldSeed ? `SIGNER_LOCAL_SEED_PREVIOUS=${oldSeed}` : '# SIGNER_LOCAL_SEED_PREVIOUS=<从密管系统取旧种子>'}

# 2. JWKS 将同时发布两把公钥, SDK 按 kid 匹配验签(内置快照兜底)
# 3. 60 天后: 移除 SIGNER_PREVIOUS_KID/SIGNER_LOCAL_SEED_PREVIOUS, 仍验旧 kid 的客户端走强制更新
# 4. 审计: 在 admin-api 审计日志记录本次轮换操作人; Vault 模式下 keyName 换为 ${newKid}(VAULT_TRANSIT_KEY_PREVIOUS=<旧 keyName>)
`);
