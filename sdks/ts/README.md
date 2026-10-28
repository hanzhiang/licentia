# License Platform TypeScript SDK

用户端只依赖三样输入：

1. 管理面板发出的授权码。
2. 产品编码和客户端版本。
3. 稳定设备指纹。

组织许可可额外传 `userId`，用于席位计数。

## 安装

仓库内直接引用：

```json
{
  "dependencies": {
    "@license-platform/sdk": "workspace:*"
  }
}
```

单独打包：

```bash
pnpm --filter @license-platform/sdk build
pnpm --filter @license-platform/sdk pack
```

## 激活与心跳

```ts
import { LicenseClient, type KvStorage } from '@license-platform/sdk';

const storage: KvStorage = {
  get: (key) => secureStore.get(key),
  set: (key, value) => secureStore.set(key, value),
  remove: (key) => secureStore.remove(key),
};

const client = new LicenseClient({
  baseUrl: 'https://license.example.com',
  productCode: 'dorm-check',
  appVersion: '2.4.1',
  userId: currentUser.id, // 个人许可可省略；组织席位需要
  device: {
    fpType: 'machine_id',
    fingerprint: stableMachineFingerprint,
    platform: 'windows',
  },
  storage,
  heartbeatIntervalMs: 0,
});

// 用户输入授权码后调用一次
const activated = await client.activate(code);
if (!activated.valid) throw new Error(activated.reason);

// 启动、恢复网络或定时任务中调用
const current = await client.heartbeat();
if (!current.valid) throw new Error(current.reason);

console.log(current.features);
```

SDK 会自动：

- 把 `fpType` 转换成服务端要求的 `fp_type`。
- 保存 `client_token`、授权码和离线许可。
- 在心跳中跟随服务端 token 轮换。
- 401 时在本地有授权码的前提下静默重激活一次。
- 网络错误和 5xx 按退避序列重试。
- 断网后用 Ed25519 离线许可和时钟回拨守卫计算权益。

## 服务端实际收到的契约

激活：

```http
POST /client/v1/activate
Content-Type: application/json
```

```json
{
  "code": "D0RM-XXXX-XXXX-XXXX-XXXX-C",
  "app": {
    "product_code": "dorm-check",
    "version": "2.4.1"
  },
  "device": {
    "fp_type": "machine_id",
    "fingerprint": "stable-machine-fingerprint",
    "platform": "windows"
  },
  "context": {
    "user_id": "student-1001"
  }
}
```

成功返回 `client_token`、授权权益、设备数和离线许可。同设备重复激活返回 200，
首次激活返回 201。

心跳：

```http
POST /client/v1/heartbeat
Authorization: Bearer ct_xxx
Content-Type: application/json
```

```json
{
  "context": {
    "user_id": "student-1001"
  }
}
```

心跳返回新的 `client_token`。客户端应立即替换旧 token，不要继续使用旧值。

## 错误处理

| code | 含义 | 客户端动作 |
|---|---|---|
| `LIC_CODE_MALFORMED` | 授权码格式或校验位错误 | 提示用户检查输入 |
| `LIC_NOT_FOUND` | 授权码不存在 | 提示联系销售 |
| `LIC_PRODUCT_MISMATCH` | 产品编码不匹配 | 检查客户端配置 |
| `LIC_VERSION_TOO_LOW` | 客户端版本过低 | 提示升级 |
| `LIC_DEVICE_LIMIT_REACHED` | 设备数已满 | 提示解绑旧设备 |
| `LIC_EXPIRED` | 已过期 | 提示续费 |
| `LIC_REVOKED` | 已吊销 | 禁止继续使用 |
| `AUTH_REQUIRED` | 会话 token 失效 | SDK 自动重激活；仍失败则要求重新输入码 |
| `SEAT_CONCURRENCY_LIMIT` | 席位或并发已满 | 提示稍后重试或扩容 |

任何错误都不要把完整授权码写入日志。管理面板只保存掩码，明文只在发码时展示一次。

## 状态存储

桌面客户端：

- Windows: DPAPI
- macOS: Keychain
- Linux: Secret Service

移动端使用 Keystore/Keychain。服务端进程使用数据库或 KMS，不要把 token 写进普通文本文件。

仓库内 `examples/node-client/activate.ts` 是可运行的本地示例。
