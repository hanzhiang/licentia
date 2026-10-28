# License Platform 交付与运维手册

本文对应单机可交付版本。管理面板地址：`http://localhost:5173`。

## 1. 启动顺序

```powershell
docker compose -f deploy/docker-compose.yml up -d
pnpm install
pnpm db:migrate
pnpm seed:users
pnpm build
pnpm build:web
```

分别启动：

```powershell
node apps/admin-api/dist/main.js
node apps/client-api/dist/main.js
node apps/open-api/dist/main.js
node apps/portal-api/dist/main.js
node apps/worker/dist/main.js
pnpm --filter lp-web preview -- --host 0.0.0.0 --port 5173
```

开发环境也可以直接执行 `pnpm dev`。`vite preview` 适合本机验收；正式部署应把
`web/dist` 交给 Nginx 等静态服务器，并把 `/api` 反向代理到 admin-api。

## 2. 管理面板账号

种子账号密码默认均为 `Passw0rd!demo`：

| 账号 | 角色 | 典型职责 |
|---|---|---|
| `super@lp.local` | 平台超管 | 跨租户管理，需要填写目标租户 ID |
| `admin@demo.local` | 租户管理员 | 产品、策略、发码、续期、吊销、审计 |
| `operator@demo.local` | 运营 | 发码、续期、渠道 |
| `support@demo.local` | 客服 | 查询授权、解绑设备 |
| `finance@demo.local` | 财务/审计 | 报表、审计只读 |

上线前必须修改全部种子密码。

### 2.1 权限矩阵

管理面板会根据登录响应中的有效权限隐藏菜单和按钮，后端仍会独立强制鉴权：

| 权限 | tenant_admin | operator | support | finance |
|---|---:|---:|---:|---:|
| `product:write` / `policy:write` | 是 | 否 | 否 | 否 |
| `channel:write` | 否 | 是 | 否 | 否 |
| `license:issue` | 是 | 是 | 否 | 否 |
| `license:read` | 是 | 是 | 是 | 是 |
| `license:renew` | 是 | 是 | 否 | 否 |
| `license:revoke:approve` | 是 | 是 | 否 | 否 |
| `device:release` | 是 | 否 | 是 | 否 |
| `end_customer:write` | 是 | 是 | 否 | 否 |
| `report:read` | 是 | 否 | 否 | 是 |
| `audit:read` | 是 | 否 | 否 | 是 |
| `apikey:write` | 是 | 否 | 否 | 否 |
| `webhook:write` | 是 | 否 | 否 | 否 |

如果看到 `缺少权限: product:write`，说明当前登录的是运营等无产品写权限的角色。
应退出后使用 `admin@demo.local`，或由租户管理员调整角色权限。不要通过前端隐藏来绕过，
后端 `PermGuard` 会继续拒绝。

Access token 默认 15 分钟。管理面板在收到 401 后会自动使用 refresh token 轮换新会话；
refresh token 失效时才返回登录页。

## 3. 授权机制怎么用

### 3.1 配置产品与策略

在「产品与策略」页面：

1. 创建产品。产品编码只允许小写字母、数字和连字符。
2. 创建渠道，可选。
3. 创建授权策略，配置有效期、设备上限、席位、功能权益、离线窗口和心跳间隔。

授权码前缀取产品编码归一化后的前 4 个字符。例如 `dorm-check` 的前缀为 `D0RM`，
因为字符 `O` 会按混淆字符规则映射为数字 `0`。

策略规则：

- `trial`：时长不超过 30 天、设备不超过 3、禁止续期。
- `perpetual`：`duration_days` 必须为空。
- `floating`：必须设置并发上限。
- 并发上限不能大于席位上限。
- 功能权益至少一个且不能重复。

### 3.2 发码

在「批量发码」页面选择产品、策略、渠道和数量，点击「生成授权码」。

授权码明文只在发码响应中展示一次。数据库保存的是：

- `code_hmac`：用于查找，不可逆。
- `code_cipher`：AES-GCM 加密。
- 管理面板只展示掩码。

码丢失时不要尝试从数据库恢复，直接吊销旧码并重新发码。

### 3.3 客户端激活

客户端调用：

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
  }
}
```

服务端会依次检查：

1. 新码的 Damm 校验位；只有旧格式码才走 legacy 兜底。
2. 产品、版本和授权状态。
3. 同一设备的幂等重放。
4. 设备数或席位限制。
5. 写入激活记录、设备记录、审计链和 Outbox 事件。

返回的 `client_token` 用于后续心跳。不要把授权码当会话凭据反复提交。

### 3.4 心跳与续期

```http
POST /client/v1/heartbeat
Authorization: Bearer ct_xxx
```

心跳会：

- 校验客户端 token 和授权状态。
- 按限流后的频率更新 `last_seen_at`。
- 返回新的 `client_token`，旧 token 只保留短暂重叠窗口。
- 续签离线许可。

管理端「授权码」页面可以执行续期、吊销和设备解绑。吊销后 Redis 会广播失效，
已解绑设备的 client token 会立即删除，下一次心跳返回 401。

### 3.5 服务端校验

业务系统通过 Open API 校验：

```http
POST /open/v1/validate
Authorization: Bearer lpk_live_xxx
Content-Type: application/json
```

```json
{
  "code": "D0RM-XXXX-XXXX-XXXX-XXXX-C"
}
```

API Key 在「API Key」页面创建。明文只在创建或轮换时展示一次。轮换后的旧 Key
有 7 天重叠期，吊销后缓存会失效。

### 3.6 TS SDK 客户端

仓库内有一个可直接运行的完整接入示例：

```powershell
$env:LICENSE_CODE = 'D0RM-XXXX-XXXX-XXXX-XXXX-C'
$env:LICENSE_USER_ID = 'student-1001'   # 组织许可可选
pnpm client:demo
```

示例代码在 `examples/node-client/activate.ts`。它会把 token、授权码和离线许可
写入状态文件，第二次启动仍可继续心跳。

```ts
import { LicenseClient } from '@license-platform/sdk';

const client = new LicenseClient({
  baseUrl: 'https://license.example.com',
  productCode: 'dorm-check',
  appVersion: '2.4.1',
  userId: currentUser.id, // 可选；组织席位按此值计数
  device: {
    fpType: 'machine_id',
    fingerprint: stableFingerprint,
    platform: 'windows',
  },
  storage: persistentEncryptedStorage,
});

await client.activate(code);
const entitlement = await client.heartbeat();
```

桌面端应把 token 和离线许可放进系统密钥库。服务端进程不要用内存存储。

### 3.7 离线许可

离线许可是 Ed25519 签名的 JWS：

- 私钥只在 signer 或 Vault Transit 中。
- 公钥通过 `/.well-known/jwks.json` 发布。
- 客户端按 `kid` 选择公钥。
- 轮换时新旧 `kid` 并行发布，旧许可在验证窗内仍可验。
- 客户端必须保存见过的最大服务端时间，检测时钟回拨。

离线窗口到期后，客户端必须重新联网。离线许可不是永久绕过服务端的手段。

## 4. 设备解绑和组织邮箱

「授权码」页面点击「详情/设备」可以查看当前绑定设备并解绑。解绑必须填写原因，
原因进入审计日志。

「终端客户」页面可以为组织许可设置联系邮箱。到期提醒依赖这个邮箱；未配置时
通知会明确标记为 `blocked`，不会伪装成 `sent`。

## 5. Webhook

在「Webhook」页面创建回调地址，事件包括：

- `license.activated`
- `license.device_bound`
- `license.device_unbound`
- `license.renewed`
- `license.revoked`
- `license.expired`
- `license.expire_warning`
- `batch.completed`
- `batch.failed`

签名头：

```text
X-LP-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
```

签名原文为 `${t}.${rawBody}`，使用创建端点时展示的密钥计算。接收方必须校验
时间窗口、HMAC 和事件幂等键。

连续失败达到窗口阈值后端点会自动熔断。管理面板可查看 `disabled_until` 并人工恢复。

## 6. 备份、恢复和演练

主机没有 PostgreSQL 客户端时，通过容器执行：

```powershell
$env:PG_CONTAINER = 'deploy-postgres-1'
```

创建备份：

```powershell
pnpm backup:create -- --out ./data/backups/prod-20261028 --keep 7
```

校验文件完整性：

```powershell
pnpm backup:verify -- --dir ./data/backups/prod-20261028
```

一键演练：

```powershell
pnpm backup:drill
```

演练会执行：

1. `pg_dump` 自定义格式备份。
2. 文件大小和 SHA-256 校验。
3. 建临时库并恢复。
4. 比对迁移版本、表行数和 `lp_app` 授权数。
5. 重算平台及全部租户的审计哈希链。
6. 删除临时库；失败时保留备份用于排查。

恢复到新库前，目标库和扩展必须先创建：

```sql
CREATE DATABASE lp_restore;
\c lp_restore
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

```powershell
pnpm backup:restore -- --dir ./data/backups/prod-20261028 `
  --database lp_restore --confirm lp_restore
```

备份目录包含数据库 dump、角色 SCRAM 口令哈希和 manifest。它属于敏感数据，
异地保存前必须用组织认可的加密方式加密，并限制访问权限。

## 7. 上线安全清单

- 修改所有种子账号密码；删除不需要的演示账号。
- 用 Vault 或 KMS 托管 JWT 和离线签名私钥。
- 设置新的 `CODE_HMAC_KEY`、`FINGERPRINT_PEPPER`、`CODE_ENC_KEY`、
  `WEBHOOK_ENC_KEY`、`NOTIFY_ADDR_ENC_KEY`。
- 数据库使用最小权限应用账号，RLS 必须保持启用。
- 全站 HTTPS；反向代理限制请求体大小、登录频率和 API Key QPS。
- 配置真实 SMTP/SMS 网关；生产环境不要启用控制台通知兜底。
- 定期执行 `pnpm backup:drill`，并把加密备份复制到异机房。
- 开启磁盘、数据库连接、审计链断裂、Webhook 死信和通知 dead 告警。
- 定期轮换 JWT 签名钥、离线许可 kid 和 API Key。
- 监控审计链验证结果；审计链断裂要按安全事件处理。

## 8. 当前交付边界

本版本适合单机或单区域小规模生产验证。多副本部署前还需要：

- Outbox 到 Kafka 的多消费者管线。
- worker 的 `FOR UPDATE SKIP LOCKED` 多实例抢占。
- PostgreSQL 高可用、PITR 和故障切换演练。
- 对象存储保存 CSV 导出文件。
- 生产级 SMTP 连接池、短信供应商回执和退信处理。
- Dart/Java/Python SDK 与等保整改材料。
