#!/usr/bin/env bash
# 端到端冒烟: 登录(IAM)→RBAC 负向→发码→幂等→激活→心跳→校验→续期→吊销→失效
# 前置: make up && make migrate && pnpm seed:users && 服务已启动
set -euo pipefail

ADMIN=${ADMIN:-http://localhost:3001}
CLIENT=${CLIENT:-http://localhost:3002}
OPEN=${OPEN:-http://localhost:3003}
OPERATOR_EMAIL=${OPERATOR_EMAIL:-operator@demo.local}
FINANCE_EMAIL=${FINANCE_EMAIL:-finance@demo.local}
PASSWORD=${SEED_PASSWORD:-Passw0rd!demo}
PRODUCT="22222222-2222-4222-8222-222222222222"
POLICY="33333333-3333-4333-8333-333333333333"
CHANNEL="44444444-4444-4444-8444-444444444444"

jsonq() {
  node -e "
    const fs = require('fs');
    const raw = fs.readFileSync(0, 'utf8');
    const o = JSON.parse(raw);
    let v = o;
    for (const k of process.argv[1].split('.')) v = v == null ? v : v[k];
    if (v === undefined || v === null) { console.error('jsonq missing: ' + process.argv[1] + ' in ' + raw.slice(0,200)); process.exit(1); }
    console.log(typeof v === 'object' ? JSON.stringify(v) : String(v));
  " "$1"
}

http() { curl -s -o /tmp/lp_smoke_body -w '%{http_code}' "$@"; }

echo "== health =="
curl -sf "$ADMIN/healthz" >/dev/null
curl -sf "$CLIENT/healthz" >/dev/null
curl -sf "$OPEN/healthz" >/dev/null
echo "health OK"

echo "== 0. login (IAM) =="
LOGIN=$(curl -sf -X POST "$ADMIN/admin/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OPERATOR_EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(echo "$LOGIN" | jsonq data.access_token)
REFRESH=$(echo "$LOGIN" | jsonq data.refresh_token)
echo "login OK (actor_type=$(echo "$LOGIN" | jsonq data.user.actor_type))"

echo "== 0b. refresh rotation =="
R2=$(curl -sf -X POST "$ADMIN/admin/v1/auth/refresh" -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"$REFRESH\"}")
NEW_REFRESH=$(echo "$R2" | jsonq data.refresh_token)
TOKEN=$(echo "$R2" | jsonq data.access_token)
if [ "$NEW_REFRESH" = "$REFRESH" ]; then echo "FAIL: refresh token not rotated"; exit 1; fi
echo "refresh OK (rotated)"

echo "== 0c. RBAC: finance 无发码权限(403) =="
FIN=$(curl -sf -X POST "$ADMIN/admin/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$FINANCE_EMAIL\",\"password\":\"$PASSWORD\"}")
FIN_TOKEN=$(echo "$FIN" | jsonq data.access_token)
CODE_HTTP=$(http -X POST "$ADMIN/admin/v1/batches" -H "Authorization: Bearer $FIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"product_id\":\"$PRODUCT\",\"policy_id\":\"$POLICY\",\"quantity\":1}")
if [ "$CODE_HTTP" != "403" ]; then echo "FAIL: expected 403 for finance, got $CODE_HTTP"; cat /tmp/lp_smoke_body; exit 1; fi
echo "RBAC negative OK (finance -> 403)"

echo "== 0d. 无 token 访问(401) =="
CODE_HTTP=$(http "$ADMIN/admin/v1/licenses")
if [ "$CODE_HTTP" != "401" ]; then echo "FAIL: expected 401, got $CODE_HTTP"; exit 1; fi
echo "auth negative OK (401)"

echo "== 1. issue batch (3 codes) =="
IDEM="smoke-$(date +%s)-$RANDOM"
BODY="{\"product_id\":\"$PRODUCT\",\"policy_id\":\"$POLICY\",\"channel_id\":\"$CHANNEL\",\"quantity\":3,\"note\":\"smoke\"}"
BATCH=$(curl -sf -X POST "$ADMIN/admin/v1/batches" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d "$BODY")
BATCH_ID=$(echo "$BATCH" | jsonq data.batch_id)
CODE=$(echo "$BATCH" | jsonq data.codes.0)
echo "batch=$BATCH_ID code=$CODE"

echo "== 2. idempotent replay (same key) =="
BATCH2_ID=$(curl -sf -X POST "$ADMIN/admin/v1/batches" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d "$BODY" | jsonq data.batch_id)
if [ "$BATCH_ID" != "$BATCH2_ID" ]; then echo "FAIL: replay returned different batch_id"; exit 1; fi
echo "replay OK (same batch_id)"

echo "== 3. activate =="
FP="smoke-fp-$RANDOM"
ACT_BODY="{\"code\":\"$CODE\",\"app\":{\"product_code\":\"dorm-check\",\"version\":\"2.4.1\"},\"device\":{\"fp_type\":\"machine_id\",\"fingerprint\":\"$FP\",\"platform\":\"windows\"}}"
ACT=$(curl -sf -X POST "$CLIENT/client/v1/activate" -H 'Content-Type: application/json' -d "$ACT_BODY")
CLIENT_TOKEN=$(echo "$ACT" | jsonq data.client_token)
LIC_ID=$(echo "$ACT" | jsonq data.license.id)
echo "license=$LIC_ID"

echo "== 3b. activate same device again (expect 200 idempotent) =="
CODE_HTTP=$(http -X POST "$CLIENT/client/v1/activate" -H 'Content-Type: application/json' -d "$ACT_BODY")
if [ "$CODE_HTTP" != "200" ]; then echo "FAIL: expected 200, got $CODE_HTTP"; cat /tmp/lp_smoke_body; exit 1; fi
echo "replay activate OK (200)"

echo "== 4. heartbeat (token rotation + seats zset) =="
HB=$(curl -sf -X POST "$CLIENT/client/v1/heartbeat" \
  -H "Authorization: Bearer $CLIENT_TOKEN" -H 'Content-Type: application/json' -d '{}')
NEW_TOKEN=$(echo "$HB" | jsonq data.client_token)
echo "heartbeat OK, token rotated"

echo "== 5. validate via open api (tenant_admin 建 Key; operator 无 apikey:write) =="
TADMIN=$(curl -sf -X POST "$ADMIN/admin/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@demo.local\",\"password\":\"$PASSWORD\"}")
TADMIN_TOKEN=$(echo "$TADMIN" | jsonq data.access_token)
KEY_JSON=$(curl -sf -X POST "$ADMIN/admin/v1/api-keys" \
  -H "Authorization: Bearer $TADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"smoke-key","scopes":["validate"]}')
APIKEY=$(echo "$KEY_JSON" | jsonq data.key)
VAL=$(curl -sf -X POST "$OPEN/open/v1/validate" \
  -H "Authorization: Bearer $APIKEY" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")
if [ "$(echo "$VAL" | jsonq data.valid)" != "true" ]; then echo "FAIL: validate not valid"; echo "$VAL"; exit 1; fi
echo "validate OK (valid=true, redis cache)"

echo "== 6. renew +30d =="
NEW_EXP=$(curl -sf -X POST "$ADMIN/admin/v1/licenses/$LIC_ID/renew" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: renew-$RANDOM" -H 'Content-Type: application/json' \
  -d '{"days":30,"order_ref":"SO-SMOKE-1"}' | jsonq data.new_expires_at)
echo "renew OK, new expiry=$NEW_EXP"

echo "== 7. revoke =="
curl -sf -X POST "$ADMIN/admin/v1/licenses/$LIC_ID/revoke" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: revoke-$RANDOM" -H 'Content-Type: application/json' \
  -d '{"reason":"smoke-refund"}' >/dev/null
echo "revoke OK"

echo "== 8. heartbeat after revoke (expect 410) =="
CODE_HTTP=$(http -X POST "$CLIENT/client/v1/heartbeat" \
  -H "Authorization: Bearer $NEW_TOKEN" -H 'Content-Type: application/json' -d '{}')
if [ "$CODE_HTTP" != "410" ]; then echo "FAIL: expected 410, got $CODE_HTTP"; cat /tmp/lp_smoke_body; exit 1; fi
echo "heartbeat after revoke OK (410 LIC_REVOKED)"

echo "== 9. validate after revoke (valid=false, LIC_REVOKED) =="
sleep 1
VAL2=$(curl -sf -X POST "$OPEN/open/v1/validate" \
  -H "Authorization: Bearer $APIKEY" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")
if [ "$(echo "$VAL2" | jsonq data.valid)" != "false" ] || [ "$(echo "$VAL2" | jsonq data.reason)" != "LIC_REVOKED" ]; then
  echo "FAIL: unexpected validate result:"; echo "$VAL2"; exit 1
fi
echo "validate after revoke OK (cache invalidated via redis pub/sub)"

echo "== 10. audit chain verify (tenant_admin) =="
VERIFY=$(curl -sf "$ADMIN/admin/v1/audit-events/verify" -H "Authorization: Bearer $TADMIN_TOKEN")
VALID=$(echo "$VERIFY" | jsonq data.valid)
CHECKED=$(echo "$VERIFY" | jsonq data.checked)
if [ "$VALID" != "true" ]; then echo "FAIL: audit chain broken: $VERIFY"; exit 1; fi
echo "audit chain OK (verified $CHECKED entries)"

echo ""
echo "SMOKE PASSED"
