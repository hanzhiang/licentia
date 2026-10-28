/**
 * 可运行的用户端接入示例：
 *
 *   $env:LICENSE_CODE='D0RM-...'
 *   pnpm client:demo
 *
 * 生产客户端应把 state 文件替换为 DPAPI/Keychain/Keystore，并使用稳定设备指纹。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LicenseClient,
  type KvStorage,
} from '../../sdks/ts/src/index';

class JsonFileStorage implements KvStorage {
  private data: Record<string, string>;

  constructor(private readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.data = fs.existsSync(filePath)
      ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, string>)
      : {};
  }

  get(key: string): string | null {
    return this.data[key] ?? null;
  }

  set(key: string, value: string): void {
    this.data[key] = value;
    this.persist();
  }

  remove(key: string): void {
    delete this.data[key];
    this.persist();
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}

function defaultFingerprint(): string {
  return crypto
    .createHash('sha256')
    .update(`${os.hostname()}:${os.platform()}:${os.arch()}`)
    .digest('hex');
}

async function main(): Promise<void> {
  const code = process.env.LICENSE_CODE ?? process.argv[2];
  if (!code) {
    throw new Error('请设置 LICENSE_CODE，或在命令行传入授权码');
  }

  const client = new LicenseClient({
    baseUrl: process.env.LICENSE_BASE_URL ?? 'http://localhost:3002',
    productCode: process.env.LICENSE_PRODUCT_CODE ?? 'dorm-check',
    appVersion: process.env.LICENSE_APP_VERSION ?? '2.4.1',
    userId: process.env.LICENSE_USER_ID,
    device: {
      fpType: 'machine_id',
      fingerprint: process.env.LICENSE_DEVICE_FINGERPRINT ?? defaultFingerprint(),
      platform:
        os.platform() === 'win32'
          ? 'windows'
          : os.platform() === 'darwin'
            ? 'macos'
            : 'linux',
    },
    storage: new JsonFileStorage(
      process.env.LICENSE_STATE_FILE ?? path.resolve('data/client-state.json'),
    ),
    heartbeatIntervalMs: 0,
  });

  const activated = await client.activate(code);
  console.log(
    JSON.stringify(
      {
        step: 'activate',
        valid: activated.valid,
        features: activated.features,
        expires_at: activated.expiresAt,
        source: activated.source,
      },
      null,
      2,
    ),
  );

  const heartbeat = await client.heartbeat();
  console.log(
    JSON.stringify(
      {
        step: 'heartbeat',
        valid: heartbeat.valid,
        features: heartbeat.features,
        expires_at: heartbeat.expiresAt,
        source: heartbeat.source,
      },
      null,
      2,
    ),
  );
}

void main().catch((e: unknown) => {
  console.error(`客户端接入失败: ${(e as Error).message}`);
  process.exitCode = 1;
});
