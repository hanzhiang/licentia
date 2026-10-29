import io, json

KEYS = 'i18n_keys.json'
keys = json.load(io.open(KEYS, encoding='utf-8'))


def add(ns, pairs):
    d = keys.setdefault(ns, {})
    for k, zh, en in pairs:
        d[k] = {'zh': zh, 'en': en}


def apply(path, R, extra=None):
    s = io.open(path, encoding='utf-8').read()
    for a, b in R:
        assert a in s, (path, a[:60])
        s = s.replace(a, b, 1)
    if extra:
        for a, b in extra:
            assert a in s, (path, a[:60])
            s = s.replace(a, b)
    io.open(path, 'w', encoding='utf-8').write(s)


I18N_IMPORT = ("import { useAuth } from '../store';",
               "import { useAuth } from '../store';\nimport { useI18n } from 'vue-i18n';")
I18N_CONST = ("const auth = useAuth();", "const auth = useAuth();\nconst { t } = useI18n();")

# ---------- EndCustomers ----------
add('customers', [
    ('title', '终端客户', 'End customers'),
    ('subtitle', '为组织授权配置联系邮箱，到期提醒才会真正投递。',
     'Set a contact email on organisation licences so expiry reminders can actually be delivered.'),
    ('colName', '客户名称', 'Customer'),
    ('colType', '类型', 'Type'),
    ('colEmail', '联系邮箱', 'Contact email'),
    ('configured', '已配置', 'Set'),
    ('notConfigured', '未配置', 'Not set'),
    ('colLicenses', '授权数', 'Licences'),
    ('colStatus', '状态', 'Status'),
    ('setEmail', '设置邮箱', 'Set email'),
    ('changeEmail', '更换邮箱', 'Change email'),
    ('dialogTitle', '维护联系邮箱', 'Contact email'),
    ('fieldCustomer', '客户', 'Customer'),
    ('emailPlaceholder', 'ops@example.com; 留空表示清除', 'ops@example.com — leave empty to clear'),
    ('updated', '联系邮箱已更新', 'Contact email updated'),
])
apply('src/views/EndCustomers.vue', [
    ('<h2>终端客户</h2>', "<h2>{{ t('customers.title') }}</h2>"),
    ('<p>为组织授权配置联系邮箱，到期提醒才会真正投递。</p>',
     "<p>{{ t('customers.subtitle') }}</p>"),
    ('<el-button :loading="loading" @click="load">刷新</el-button>',
     '<el-button :loading="loading" @click="load">{{ t(\'common.refresh\') }}</el-button>'),
    ('label="客户名称" min-width="220"', ':label="t(\'customers.colName\')" min-width="220"'),
    ('label="类型" width="100"', ':label="t(\'customers.colType\')" width="100"'),
    ('<el-table-column label="联系邮箱" width="130">',
     '<el-table-column :label="t(\'customers.colEmail\')" width="130">'),
    ("{{ row.has_email ? '已配置' : '未配置' }}",
     "{{ row.has_email ? t('customers.configured') : t('customers.notConfigured') }}"),
    ('label="授权数" width="90"', ':label="t(\'customers.colLicenses\')" width="90"'),
    ('label="状态" width="100"', ':label="t(\'customers.colStatus\')" width="100"'),
    ('<el-table-column label="操作" width="140">',
     '<el-table-column :label="t(\'common.actions\')" width="140">'),
    ("{{ row.has_email ? '更换邮箱' : '设置邮箱' }}",
     "{{ row.has_email ? t('customers.changeEmail') : t('customers.setEmail') }}"),
    ('title="维护联系邮箱"', ':title="t(\'customers.dialogTitle\')"'),
    ('<el-form-item label="客户">', '<el-form-item :label="t(\'customers.fieldCustomer\')">'),
    ('<el-form-item label="邮箱">', '<el-form-item :label="t(\'customers.colEmail\')">'),
    ('placeholder="ops@example.com; 留空表示清除"', ':placeholder="t(\'customers.emailPlaceholder\')"'),
    ('<el-button @click="dialog = false">取消</el-button>',
     '<el-button @click="dialog = false">{{ t(\'common.cancel\') }}</el-button>'),
    ('>保存</el-button>', ">{{ t('common.save') }}</el-button>"),
    ("ElMessage.success('联系邮箱已更新');", "ElMessage.success(t('customers.updated'));"),
    I18N_IMPORT, I18N_CONST,
])

# ---------- Reports ----------
add('reports', [
    ('title', '渠道/批次统计(激活率、活跃、退款回收)',
     'Channel / batch stats (activation rate, active, refunded)'),
    ('colBatch', '批次', 'Batch'),
    ('colChannel', '渠道', 'Channel'),
    ('colQuantity', '发码量', 'Issued'),
    ('colActivated', '已激活', 'Activated'),
    ('colActive', '活跃', 'Active'),
    ('colRevoked', '吊销(退款)', 'Revoked (refund)'),
    ('colRate', '激活率', 'Activation rate'),
])
apply('src/views/Reports.vue', [
    ('<span>渠道/批次统计(激活率、活跃、退款回收)</span>',
     '<span>{{ t(\'reports.title\') }}</span>'),
    ('<el-button size="small" @click="load">刷新</el-button>',
     '<el-button size="small" @click="load">{{ t(\'common.refresh\') }}</el-button>'),
    ('label="批次" width="280"', ':label="t(\'reports.colBatch\')" width="280"'),
    ('label="渠道" width="140"', ':label="t(\'reports.colChannel\')" width="140"'),
    ('label="发码量" width="100"', ':label="t(\'reports.colQuantity\')" width="100"'),
    ('label="已激活" width="100"', ':label="t(\'reports.colActivated\')" width="100"'),
    ('label="活跃" width="100"', ':label="t(\'reports.colActive\')" width="100"'),
    ('label="吊销(退款)" width="110"', ':label="t(\'reports.colRevoked\')" width="110"'),
    ('<el-table-column label="激活率">', '<el-table-column :label="t(\'reports.colRate\')">'),
    ("import { api, errMsg } from '../api';",
     "import { api, errMsg } from '../api';\nimport { useI18n } from 'vue-i18n';\n\nconst { t } = useI18n();"),
])

# ---------- AuditEvents ----------
add('audit', [
    ('title', '审计日志(租户级哈希链, 防篡改)', 'Audit log (per-tenant hash chain, tamper-evident)'),
    ('verify', '验链', 'Verify chain'),
    ('verified', '链完整(校验 {n} 条)', 'Chain intact ({n} entries)'),
    ('broken', '链断裂 @ id={id}', 'Chain broken at id={id}'),
    ('colTime', '时间', 'Time'),
    ('colActor', '角色', 'Actor'),
    ('colAction', '操作', 'Action'),
    ('colResource', '资源', 'Resource'),
    ('colResourceId', '资源ID', 'Resource ID'),
    ('colDetail', '详情', 'Detail'),
])
apply('src/views/AuditEvents.vue', [
    ('<span>审计日志(租户级哈希链, 防篡改)</span>', '<span>{{ t(\'audit.title\') }}</span>'),
    ('@click="verify" :loading="verifying">验链</el-button>',
     '@click="verify" :loading="verifying">{{ t(\'audit.verify\') }}</el-button>'),
    ("{{ verifyResult.valid ? `链完整(校验 ${verifyResult.checked} 条)` : `链断裂 @ id=${verifyResult.brokenAtId}` }}",
     "{{ verifyResult.valid\n              ? t('audit.verified', { n: verifyResult.checked })\n              : t('audit.broken', { id: verifyResult.brokenAtId }) }}"),
    ('label="时间" width="180"', ':label="t(\'audit.colTime\')" width="180"'),
    ('label="角色" width="120"', ':label="t(\'audit.colActor\')" width="120"'),
    ('label="操作" width="180"', ':label="t(\'audit.colAction\')" width="180"'),
    ('label="资源" width="140"', ':label="t(\'audit.colResource\')" width="140"'),
    ('label="资源ID" width="280"', ':label="t(\'audit.colResourceId\')" width="280"'),
    ('<el-table-column label="详情">', '<el-table-column :label="t(\'audit.colDetail\')">'),
    ("import { api, errMsg } from '../api';",
     "import { api, errMsg } from '../api';\nimport { useI18n } from 'vue-i18n';\n\nconst { t } = useI18n();"),
])

# ---------- ApiKeys ----------
add('apiKeys', [
    ('title', 'API Key(开放 API, 明文仅创建时可见一次)',
     'API keys (open API; plaintext is shown once at creation)'),
    ('create', '新建', 'New'),
    ('colName', '名称', 'Name'),
    ('colPrefix', '前缀', 'Prefix'),
    ('colScopes', 'scopes', 'Scopes'),
    ('colRateLimit', '限流 QPS', 'Rate limit (QPS)'),
    ('colStatus', '状态', 'Status'),
    ('colLastUsed', '最近使用', 'Last used'),
    ('rotate', '轮换', 'Rotate'),
    ('revoke', '吊销', 'Revoke'),
    ('dialogTitle', '新建 API Key', 'New API key'),
    ('namePlaceholder', '如: 客户业务系统-生产', 'e.g. customer backend — production'),
    ('scopeValidate', 'validate(服务端校验)', 'validate (server-side check)'),
    ('createdTitle', '请立即保存 API Key(关闭后不再显示)', 'Save this API key now (it will not be shown again)'),
    ('rotateConfirm', '旧 Key 将保留 7 天重叠期后失效, 确认轮换?',
     'The old key keeps working for a 7-day overlap, then expires. Rotate?'),
    ('rotateTitle', '轮换 {name}', 'Rotate {name}'),
    ('revokeConfirm', '吊销后立即失效(缓存/网关 1 分钟内全量生效), 确认?',
     'Revoking takes effect immediately (fully propagated within a minute). Continue?'),
    ('revokeTitle', '吊销 {name}', 'Revoke {name}'),
    ('revoked', '已吊销', 'Revoked'),
])
apply('src/views/ApiKeys.vue', [
    ('<span>API Key(开放 API, 明文仅创建时可见一次)</span>',
     '<span>{{ t(\'apiKeys.title\') }}</span>'),
    ('          新建\n', "          {{ t('apiKeys.create') }}\n"),
    ('label="名称" width="180"', ':label="t(\'apiKeys.colName\')" width="180"'),
    ('label="前缀" width="200"', ':label="t(\'apiKeys.colPrefix\')" width="200"'),
    ('<el-table-column label="scopes" width="200">',
     '<el-table-column :label="t(\'apiKeys.colScopes\')" width="200">'),
    ('label="限流 QPS" width="100"', ':label="t(\'apiKeys.colRateLimit\')" width="100"'),
    ('label="状态" width="110"', ':label="t(\'apiKeys.colStatus\')" width="110"'),
    ('label="最近使用" width="170"', ':label="t(\'apiKeys.colLastUsed\')" width="170"'),
    ('<el-table-column label="操作" width="170">',
     '<el-table-column :label="t(\'common.actions\')" width="170">'),
    ('@click="rotate(row)">轮换</el-button>', '@click="rotate(row)">{{ t(\'apiKeys.rotate\') }}</el-button>'),
    ('@click="revoke(row)">吊销</el-button>', '@click="revoke(row)">{{ t(\'apiKeys.revoke\') }}</el-button>'),
    ('title="新建 API Key"', ':title="t(\'apiKeys.dialogTitle\')"'),
    ('<el-form-item label="名称">', '<el-form-item :label="t(\'apiKeys.colName\')">'),
    ('placeholder="如: 客户业务系统-生产"', ':placeholder="t(\'apiKeys.namePlaceholder\')"'),
    ('<el-form-item label="scopes">', '<el-form-item :label="t(\'apiKeys.colScopes\')">'),
    ('<el-checkbox value="validate">validate(服务端校验)</el-checkbox>',
     '<el-checkbox value="validate">{{ t(\'apiKeys.scopeValidate\') }}</el-checkbox>'),
    ('<el-button @click="dialog = false">取消</el-button>',
     '<el-button @click="dialog = false">{{ t(\'common.cancel\') }}</el-button>'),
    ('>创建</el-button>', ">{{ t('common.create') }}</el-button>"),
    ('title="请立即保存 API Key(关闭后不再显示)"', ':title="t(\'apiKeys.createdTitle\')"'),
    ("""      '旧 Key 将保留 7 天重叠期后失效, 确认轮换?',
      `轮换 ${row.name}`,""",
     """      t('apiKeys.rotateConfirm'),
      t('apiKeys.rotateTitle', { name: row.name }),"""),
    ("""await ElMessageBox.confirm('吊销后立即失效(缓存/网关 1 分钟内全量生效), 确认?', `吊销 ${row.name}`, { type: 'warning' });""",
     """await ElMessageBox.confirm(
      t('apiKeys.revokeConfirm'),
      t('apiKeys.revokeTitle', { name: row.name }),
      { type: 'warning' },
    );"""),
    ("ElMessage.success('已吊销');", "ElMessage.success(t('apiKeys.revoked'));"),
    I18N_IMPORT, I18N_CONST,
])

# ---------- Webhooks ----------
add('webhooks', [
    ('title', 'Webhook 投递', 'Webhook delivery'),
    ('subtitle', 'HMAC 签名投递，失败自动退避；连续失败会熔断，避免拖垮业务系统。',
     'HMAC-signed delivery with exponential backoff; repeated failures trip a circuit breaker so your systems are not overwhelmed.'),
    ('newEndpoint', '新建端点', 'New endpoint'),
    ('colUrl', '回调地址', 'Callback URL'),
    ('colEvents', '订阅事件', 'Events'),
    ('colStatus', '状态', 'Status'),
    ('colFailureCount', '熔断次数', 'Trips'),
    ('colDisabledUntil', '自动恢复时间', 'Auto-resume at'),
    ('rotateSecret', '轮换密钥', 'Rotate secret'),
    ('restore', '恢复', 'Restore'),
    ('dialogTitle', '新建 Webhook 端点', 'New webhook endpoint'),
    ('urlPlaceholder', 'https://example.com/webhooks/license', 'https://example.com/webhooks/license'),
    ('allEvents', '全部事件 (*)', 'All events (*)'),
    ('secretTitle', '请立即保存签名密钥', 'Save the signing secret now'),
    ('secretNote', '该密钥只显示一次，关闭后无法再次查看。',
     'The secret is shown only once and cannot be retrieved later.'),
    ('rotateConfirm', '旧密钥会立即失效，确认轮换?', 'The old secret stops working immediately. Rotate?'),
    ('rotateTitle', '轮换 {url}', 'Rotate {url}'),
    ('resetConfirm', '将端点恢复为 active 并从 1 分钟冷却重新计数。',
     'Restore the endpoint to active and restart the cooldown ladder at one minute.'),
    ('resetTitle', '恢复 {url}', 'Restore {url}'),
    ('restored', '端点已恢复', 'Endpoint restored'),
])
apply('src/views/Webhooks.vue', [
    ('<h2>Webhook 投递</h2>', "<h2>{{ t('webhooks.title') }}</h2>"),
    ('<p>HMAC 签名投递，失败自动退避；连续失败会熔断，避免拖垮业务系统。</p>',
     "<p>{{ t('webhooks.subtitle') }}</p>"),
    ('<el-button :loading="loading" @click="load">刷新</el-button>',
     '<el-button :loading="loading" @click="load">{{ t(\'common.refresh\') }}</el-button>'),
    ('            新建端点\n', "            {{ t('webhooks.newEndpoint') }}\n"),
    ('label="回调地址" min-width="300"', ':label="t(\'webhooks.colUrl\')" min-width="300"'),
    ('<el-table-column label="订阅事件" min-width="220">',
     '<el-table-column :label="t(\'webhooks.colEvents\')" min-width="220">'),
    ('<el-table-column label="状态" width="120">',
     '<el-table-column :label="t(\'webhooks.colStatus\')" width="120">'),
    ('label="熔断次数" width="100"', ':label="t(\'webhooks.colFailureCount\')" width="100"'),
    ('<el-table-column label="自动恢复时间" width="190">',
     '<el-table-column :label="t(\'webhooks.colDisabledUntil\')" width="190">'),
    ('<el-table-column label="操作" width="240">',
     '<el-table-column :label="t(\'common.actions\')" width="240">'),
    ('@click="rotate(row)">轮换密钥</el-button>',
     '@click="rotate(row)">{{ t(\'webhooks.rotateSecret\') }}</el-button>'),
    ('            恢复\n', "            {{ t('webhooks.restore') }}\n"),
    ('title="新建 Webhook 端点"', ':title="t(\'webhooks.dialogTitle\')"'),
    ('<el-form-item label="回调地址">', '<el-form-item :label="t(\'webhooks.colUrl\')">'),
    ('<el-form-item label="订阅事件">', '<el-form-item :label="t(\'webhooks.colEvents\')">'),
    ('<el-option label="全部事件 (*)" value="*" />',
     '<el-option :label="t(\'webhooks.allEvents\')" value="*" />'),
    ('<el-button @click="dialog = false">取消</el-button>',
     '<el-button @click="dialog = false">{{ t(\'common.cancel\') }}</el-button>'),
    ('>创建</el-button>', ">{{ t('common.create') }}</el-button>"),
    ('title="请立即保存签名密钥"', ':title="t(\'webhooks.secretTitle\')"'),
    ('title="该密钥只显示一次，关闭后无法再次查看。"', ':title="t(\'webhooks.secretNote\')"'),
    ("await ElMessageBox.confirm('旧密钥会立即失效，确认轮换?', `轮换 ${row.url}`, { type: 'warning' });",
     "await ElMessageBox.confirm(\n      t('webhooks.rotateConfirm'),\n      t('webhooks.rotateTitle', { url: row.url }),\n      { type: 'warning' },\n    );"),
    ("await ElMessageBox.confirm('将端点恢复为 active 并从 1 分钟冷却重新计数。', `恢复 ${row.url}`);",
     "await ElMessageBox.confirm(t('webhooks.resetConfirm'), t('webhooks.resetTitle', { url: row.url }));"),
    ("ElMessage.success('端点已恢复');", "ElMessage.success(t('webhooks.restored'));"),
    I18N_IMPORT, I18N_CONST,
])

json.dump(keys, io.open(KEYS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('ok')
