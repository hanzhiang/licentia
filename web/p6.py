import io, json

KEYS = 'i18n_keys.json'
keys = json.load(io.open(KEYS, encoding='utf-8'))


def add(ns, pairs):
    d = keys.setdefault(ns, {})
    for k, zh, en in pairs:
        d[k] = {'zh': zh, 'en': en}


class Doc:
    def __init__(self, path):
        self.path = path
        self.s = io.open(path, encoding='utf-8').read()

    def rep(self, old, new, n=1):
        c = self.s.count(old)
        assert c == n, (self.path, c, n, old[:70])
        self.s = self.s.replace(old, new)

    def save(self):
        io.open(self.path, 'w', encoding='utf-8').write(self.s)


add('catalog', [
    ('title', '产品与授权策略', 'Products & policies'),
    ('subtitle', '产品决定授权码前缀，策略决定有效期、设备数、席位与功能权益。',
     'A product sets the license-code prefix; a policy sets validity, devices, seats and entitlements.'),
    ('tabProducts', '产品', 'Products'),
    ('tabPolicies', '授权策略', 'Policies'),
    ('tabChannels', '渠道', 'Channels'),
    ('countProducts', '共 {n} 个产品', '{n} products'),
    ('countPolicies', '共 {n} 个策略', '{n} policies'),
    ('countChannels', '共 {n} 个渠道', '{n} channels'),
    ('newProduct', '新建产品', 'New product'),
    ('newPolicy', '新建策略', 'New policy'),
    ('newChannel', '新建渠道', 'New channel'),
    ('colProductCode', '产品编码', 'Product code'),
    ('colProductName', '产品名称', 'Product name'),
    ('colProductId', '产品 ID', 'Product ID'),
    ('colChannelCode', '渠道编码', 'Channel code'),
    ('colChannelName', '渠道名称', 'Channel name'),
    ('colChannelId', '渠道 ID', 'Channel ID'),
    ('colPolicyName', '策略名称', 'Policy name'),
    ('colProduct', '产品', 'Product'),
    ('colKind', '类型', 'Type'),
    ('colValidity', '有效期', 'Validity'),
    ('colDevices', '设备数', 'Devices'),
    ('colSeats', '席位', 'Seats'),
    ('colFeatures', '功能', 'Features'),
    ('colStatus', '状态', 'Status'),
    ('days', '{n} 天', '{n} days'),
    ('perpetual', '永久', 'Perpetual'),
    ('codePlaceholder', '如 school-dorm', 'e.g. school-dorm'),
    ('namePlaceholder', '如 校园宿舍管理系统', 'e.g. Campus dorm management'),
    ('channelCodePlaceholder', '如 east-partner', 'e.g. east-partner'),
    ('channelNamePlaceholder', '如 华东代理商', 'e.g. East China reseller'),
    ('createPolicyTitle', '新建授权策略', 'New policy'),
    ('fieldCode', '策略编码', 'Policy code'),
    ('fieldName', '策略名称', 'Policy name'),
    ('policyNamePlaceholder', '标准版 365 天', 'Standard 365 days'),
    ('fieldKind', '授权类型', 'License type'),
    ('kind.standard', '标准', 'Standard'),
    ('kind.trial', '试用', 'Trial'),
    ('kind.perpetual', '永久', 'Perpetual'),
    ('kind.subscription', '订阅', 'Subscription'),
    ('kind.floating', '浮动', 'Floating'),
    ('fieldDuration', '有效期(天)', 'Validity (days)'),
    ('fieldDeviceLimit', '设备数上限', 'Device limit'),
    ('fieldSeatLimit', '席位上限', 'Seat limit'),
    ('fieldConcurrency', '并发上限', 'Concurrency limit'),
    ('fieldOffline', '离线窗口(天)', 'Offline window (days)'),
    ('fieldHeartbeat', '心跳间隔(小时)', 'Heartbeat interval (hours)'),
    ('fieldRenewWindow', '续期窗口(天)', 'Renewal window (days)'),
    ('fieldFeatures', '功能权益', 'Entitlements'),
    ('featuresPlaceholder', 'dorm,leave,report (逗号分隔)', 'dorm,leave,report (comma separated)'),
    ('allowRenewal', '允许续期', 'Allow renewal'),
    ('minVersion', '最低客户端版本', 'Minimum client version'),
    ('minVersionPlaceholder', '>=2.0.0，可留空', '>=2.0.0, optional'),
    ('createPolicy', '创建策略', 'Create policy'),
    ('editProductTitle', '编辑产品', 'Edit product'),
    ('editChannelTitle', '编辑渠道', 'Edit channel'),
    ('editPolicyTitle', '编辑策略', 'Edit policy'),
    ('enabled', '启用', 'Active'),
    ('inactive', '停用', 'Disabled'),
    ('productDisableTip', '停用后不能再发新码，已发出的授权不受影响。',
     'Disabling blocks new codes; licences already issued are unaffected.'),
    ('policyEditTip', '改动只影响之后新发的授权码；已发出的码保留发码时的字段快照。',
     'Changes apply only to codes issued afterwards; existing codes keep the snapshot taken when they were issued.'),
    ('deviceLimitShort', '设备数', 'Devices'),
    ('seatLimitShort', '席位数', 'Seats'),
    ('concurrencyShort', '并发数', 'Concurrency'),
    ('createdProduct', '产品已创建', 'Product created'),
    ('createdChannel', '渠道已创建', 'Channel created'),
    ('createdPolicy', '策略已创建', 'Policy created'),
    ('updatedProduct', '产品已更新', 'Product updated'),
    ('updatedChannel', '渠道已更新', 'Channel updated'),
    ('updatedPolicy', '策略已更新', 'Policy updated'),
    ('deleted', '已删除', 'Deleted'),
    ('deleteConfirm', '确认删除「{name}」？已发过码的对象不能删除，只能停用。',
     'Delete “{name}”? Objects that have already issued codes cannot be deleted, only disabled.'),
    ('deleteTitle', '删除确认', 'Confirm deletion'),
])

d = Doc('src/views/Catalog.vue')
d.rep('<h2>产品与授权策略</h2>', "<h2>{{ t('catalog.title') }}</h2>")
d.rep('<p>产品决定授权码前缀，策略决定有效期、设备数、席位与功能权益。</p>',
      "<p>{{ t('catalog.subtitle') }}</p>")
d.rep('<el-button :loading="loading" @click="load">刷新</el-button>',
      '<el-button :loading="loading" @click="load">{{ t(\'common.refresh\') }}</el-button>')
d.rep('<el-tab-pane label="产品" name="products">',
      '<el-tab-pane :label="t(\'catalog.tabProducts\')" name="products">')
d.rep('<el-tab-pane label="授权策略" name="policies">',
      '<el-tab-pane :label="t(\'catalog.tabPolicies\')" name="policies">')
d.rep('<el-tab-pane label="渠道" name="channels">',
      '<el-tab-pane :label="t(\'catalog.tabChannels\')" name="channels">')
d.rep('<span>共 {{ catalog.products.length }} 个产品</span>',
      "<span>{{ t('catalog.countProducts', { n: catalog.products.length }) }}</span>")
d.rep('<span>共 {{ catalog.policies.length }} 个策略</span>',
      "<span>{{ t('catalog.countPolicies', { n: catalog.policies.length }) }}</span>")
d.rep('<span>共 {{ catalog.channels.length }} 个渠道</span>',
      "<span>{{ t('catalog.countChannels', { n: catalog.channels.length }) }}</span>")
d.rep('>\n            新建产品\n          </el-button>',
      ">\n            {{ t('catalog.newProduct') }}\n          </el-button>")
d.rep('>\n            新建策略\n          </el-button>',
      ">\n            {{ t('catalog.newPolicy') }}\n          </el-button>")
d.rep('>\n            新建渠道\n          </el-button>',
      ">\n            {{ t('catalog.newChannel') }}\n          </el-button>")

d.rep('<el-table-column prop="code" label="产品编码" min-width="180" />',
      '<el-table-column prop="code" :label="t(\'catalog.colProductCode\')" min-width="180" />')
d.rep('<el-table-column prop="name" label="产品名称" min-width="220" />',
      '<el-table-column prop="name" :label="t(\'catalog.colProductName\')" min-width="220" />')
d.rep('<el-table-column prop="status" label="状态" width="110" />',
      '<el-table-column prop="status" :label="t(\'catalog.colStatus\')" width="110" />', 2)
d.rep('<el-table-column prop="id" label="产品 ID" min-width="280" />',
      '<el-table-column prop="id" :label="t(\'catalog.colProductId\')" min-width="280" />')
d.rep('<el-table-column label="操作" width="90">',
      '<el-table-column :label="t(\'common.actions\')" width="90">', 3)
d.rep('>\n                编辑\n              </el-button>',
      ">\n                {{ t('common.edit') }}\n              </el-button>", 3)
d.rep('>\n                删除\n              </el-button>',
      ">\n                {{ t('common.delete') }}\n              </el-button>", 3)

d.rep('<el-table-column prop="name" label="策略名称" min-width="180" />',
      '<el-table-column prop="name" :label="t(\'catalog.colPolicyName\')" min-width="180" />')
d.rep('<el-table-column prop="product_name" label="产品" min-width="160" />',
      '<el-table-column prop="product_name" :label="t(\'catalog.colProduct\')" min-width="160" />')
d.rep('<el-table-column prop="kind" label="类型" width="110" />',
      '<el-table-column prop="kind" :label="t(\'catalog.colKind\')" width="110" />')
d.rep('<el-table-column label="有效期" width="100">',
      '<el-table-column :label="t(\'catalog.colValidity\')" width="100">')
d.rep("{{ row.duration_days ? `${row.duration_days} 天` : '永久' }}",
      "{{ row.duration_days ? t('catalog.days', { n: row.duration_days }) : t('catalog.perpetual') }}")
d.rep('<el-table-column prop="device_limit" label="设备数" width="90" />',
      '<el-table-column prop="device_limit" :label="t(\'catalog.colDevices\')" width="90" />')
d.rep('<el-table-column prop="seat_limit" label="席位" width="80">',
      '<el-table-column prop="seat_limit" :label="t(\'catalog.colSeats\')" width="80">')
d.rep('<el-table-column label="功能" min-width="180">',
      '<el-table-column :label="t(\'catalog.colFeatures\')" min-width="180">')
d.rep('<el-table-column prop="status" label="状态" width="100" />',
      '<el-table-column prop="status" :label="t(\'catalog.colStatus\')" width="100" />')

d.rep('<el-table-column prop="code" label="渠道编码" min-width="180" />',
      '<el-table-column prop="code" :label="t(\'catalog.colChannelCode\')" min-width="180" />')
d.rep('<el-table-column prop="name" label="渠道名称" min-width="220" />',
      '<el-table-column prop="name" :label="t(\'catalog.colChannelName\')" min-width="220" />')
d.rep('<el-table-column prop="id" label="渠道 ID" min-width="280" />',
      '<el-table-column prop="id" :label="t(\'catalog.colChannelId\')" min-width="280" />')

# --- 新建产品 弹窗 ---
d.rep('<el-dialog v-model="productDialog" title="新建产品" width="480px">',
      '<el-dialog v-model="productDialog" :title="t(\'catalog.newProduct\')" width="480px">')
d.rep('<el-form-item label="产品编码">', '<el-form-item :label="t(\'catalog.colProductCode\')">', 2)
d.rep('placeholder="如 school-dorm"', ':placeholder="t(\'catalog.codePlaceholder\')"')
d.rep('<el-form-item label="产品名称">', '<el-form-item :label="t(\'catalog.colProductName\')">', 2)
d.rep('placeholder="如 校园宿舍管理系统"', ':placeholder="t(\'catalog.namePlaceholder\')"')
d.rep('>取消</el-button>', ">{{ t('common.cancel') }}</el-button>", 6)
d.rep('>创建</el-button>', ">{{ t('common.create') }}</el-button>", 2)

# --- 新建渠道 弹窗 ---
d.rep('<el-dialog v-model="channelDialog" title="新建渠道" width="480px">',
      '<el-dialog v-model="channelDialog" :title="t(\'catalog.newChannel\')" width="480px">')
d.rep('<el-form-item label="渠道编码">', '<el-form-item :label="t(\'catalog.colChannelCode\')">', 2)
d.rep('placeholder="如 east-partner"', ':placeholder="t(\'catalog.channelCodePlaceholder\')"')
d.rep('<el-form-item label="渠道名称">', '<el-form-item :label="t(\'catalog.colChannelName\')">', 2)
d.rep('placeholder="如 华东代理商"', ':placeholder="t(\'catalog.channelNamePlaceholder\')"')

# --- 新建策略 弹窗 ---
d.rep('<el-dialog v-model="policyDialog" title="新建授权策略" width="720px">',
      '<el-dialog v-model="policyDialog" :title="t(\'catalog.createPolicyTitle\')" width="720px">')
d.rep('<el-form-item label="产品">', '<el-form-item :label="t(\'catalog.colProduct\')">')
d.rep('<el-form-item label="策略编码">', '<el-form-item :label="t(\'catalog.fieldCode\')">')
d.rep('<el-form-item label="策略名称">', '<el-form-item :label="t(\'catalog.fieldName\')">', 2)
d.rep('placeholder="标准版 365 天"', ':placeholder="t(\'catalog.policyNamePlaceholder\')"')
d.rep('<el-form-item label="授权类型">', '<el-form-item :label="t(\'catalog.fieldKind\')">')
for kind, key in [('standard', 'standard'), ('trial', 'trial'), ('perpetual', 'perpetual'),
                  ('subscription', 'subscription'), ('floating', 'floating')]:
    d.rep(f'<el-option label="' + {'standard': '标准', 'trial': '试用', 'perpetual': '永久',
                                     'subscription': '订阅', 'floating': '浮动'}[kind]
          + f'" value="{kind}" />',
          f'<el-option :label="t(\'catalog.kind.{key}\')" value="{kind}" />')
d.rep('<el-form-item label="有效期(天)">', '<el-form-item :label="t(\'catalog.fieldDuration\')">', 2)
d.rep('<el-form-item label="设备数上限">', '<el-form-item :label="t(\'catalog.fieldDeviceLimit\')">')
d.rep('<el-form-item label="席位上限">', '<el-form-item :label="t(\'catalog.fieldSeatLimit\')">')
d.rep('<el-form-item label="并发上限">', '<el-form-item :label="t(\'catalog.fieldConcurrency\')">')
d.rep('<el-form-item label="离线窗口(天)">', '<el-form-item :label="t(\'catalog.fieldOffline\')">', 2)
d.rep('<el-form-item label="心跳间隔(小时)">',
      '<el-form-item :label="t(\'catalog.fieldHeartbeat\')">', 2)
d.rep('<el-form-item label="续期窗口(天)">', '<el-form-item :label="t(\'catalog.fieldRenewWindow\')">')
d.rep('<el-form-item label="功能权益">', '<el-form-item :label="t(\'catalog.fieldFeatures\')">', 2)
d.rep('placeholder="dorm,leave,report (逗号分隔)"',
      ':placeholder="t(\'catalog.featuresPlaceholder\')"')
d.rep('<el-form-item label="允许续期">', '<el-form-item :label="t(\'catalog.allowRenewal\')">', 2)
d.rep('<el-form-item label="最低客户端版本">', '<el-form-item :label="t(\'catalog.minVersion\')">')
d.rep('placeholder=">=2.0.0，可留空"', ':placeholder="t(\'catalog.minVersionPlaceholder\')"')
d.rep('>创建策略</el-button>', ">{{ t('catalog.createPolicy') }}</el-button>")

# --- 编辑弹窗 ---
d.rep('<el-dialog v-model="editProductDialog" title="编辑产品" width="460px">',
      '<el-dialog v-model="editProductDialog" :title="t(\'catalog.editProductTitle\')" width="460px">')
d.rep('<el-dialog v-model="editChannelDialog" title="编辑渠道" width="460px">',
      '<el-dialog v-model="editChannelDialog" :title="t(\'catalog.editChannelTitle\')" width="460px">')
d.rep('<el-dialog v-model="editPolicyDialog" title="编辑策略" width="560px">',
      '<el-dialog v-model="editPolicyDialog" :title="t(\'catalog.editPolicyTitle\')" width="560px">')
d.rep('<el-form-item label="状态">', '<el-form-item :label="t(\'catalog.colStatus\')">', 3)
d.rep('active-text="启用"', ':active-text="t(\'catalog.enabled\')"', 3)
d.rep('inactive-text="停用"', ':inactive-text="t(\'catalog.inactive\')"', 3)
d.rep('<el-form-item label="设备数">', '<el-form-item :label="t(\'catalog.deviceLimitShort\')">')
d.rep('<el-form-item label="席位数">', '<el-form-item :label="t(\'catalog.seatLimitShort\')">')
d.rep('<el-form-item label="并发数">', '<el-form-item :label="t(\'catalog.concurrencyShort\')">')
d.rep('>保存</el-button>', ">{{ t('common.save') }}</el-button>", 3)

d.rep('<p class="tip">停用后不能再发新码，已发出的授权不受影响。</p>',
      '<p class="tip">{{ t(\'catalog.productDisableTip\') }}</p>')
d.rep('<p class="tip">改动只影响之后新发的授权码；已发出的码保留发码时的字段快照。</p>',
      '<p class="tip">{{ t(\'catalog.policyEditTip\') }}</p>')

# --- script ---
d.rep("import { useAuth } from '../store';",
      "import { useAuth } from '../store';\nimport { useI18n } from 'vue-i18n';")
d.rep('const auth = useAuth();', 'const auth = useAuth();\nconst { t } = useI18n();')
for zh, key in [('产品已创建', 'createdProduct'), ('渠道已创建', 'createdChannel'),
                ('策略已创建', 'createdPolicy'), ('产品已更新', 'updatedProduct'),
                ('渠道已更新', 'updatedChannel'), ('策略已更新', 'updatedPolicy'),
                ('已删除', 'deleted')]:
    d.rep(f"ElMessage.success('{zh}');", f"ElMessage.success(t('catalog.{key}'));")
d.rep("""      `确认删除「${row.name}」？已发过码的对象不能删除，只能停用。`,
      '删除确认',""",
      """      t('catalog.deleteConfirm', { name: row.name }),
      t('catalog.deleteTitle'),""")
d.save()

# --- Register.vue 遗漏的一处 ---
add('register', [('resentCode', '验证码已重新发送', 'Verification code resent')])
r = Doc('src/views/Register.vue')
r.rep("ElMessage.success('验证码已重新发送');", "ElMessage.success(t('register.resentCode'));")
r.save()

json.dump(keys, io.open(KEYS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('ok', len(keys), 'namespaces')
