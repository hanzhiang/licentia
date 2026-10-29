import io, json, re

BASE = {
    'app': {'name': ('许可控制台', 'License Console'),
            'tagline': ('授权与许可管理平台', 'Licensing & entitlement platform')},
    'nav': {
        'developers': ('开发者账号', 'Developer accounts'),
        'licenses': ('授权码', 'Licenses'),
        'catalog': ('产品与渠道', 'Products & channels'),
        'batches': ('批次与发码', 'Batches & issuing'),
        'deviceRequests': ('待批准设备', 'Pending devices'),
        'customers': ('终端客户', 'End customers'),
        'members': ('团队成员', 'Team members'),
        'reports': ('渠道报表', 'Channel reports'),
        'audit': ('审计日志', 'Audit log'),
        'apiKeys': ('API Key', 'API keys'),
        'webhooks': ('Webhook', 'Webhooks'),
        'groupApp': ('我的应用', 'My apps'),
        'groupSecurity': ('安全与集成', 'Security & integrations'),
        'groupPlatform': ('平台管理', 'Platform'),
        'logout': ('退出登录', 'Sign out'),
        'language': ('语言', 'Language'),
    },
    'common': {
        'refresh': ('刷新', 'Refresh'), 'save': ('保存', 'Save'), 'cancel': ('取消', 'Cancel'),
        'create': ('创建', 'Create'), 'edit': ('编辑', 'Edit'), 'delete': ('删除', 'Delete'),
        'confirm': ('确认', 'Confirm'), 'status': ('状态', 'Status'), 'actions': ('操作', 'Actions'),
        'name': ('名称', 'Name'), 'email': ('邮箱', 'Email'), 'password': ('密码', 'Password'),
        'none': ('不限', 'Unlimited'), 'empty': ('暂无数据', 'No data'), 'copied': ('已复制', 'Copied'),
    },
    'login': {
        'title': ('授权与许可管理平台', 'Licensing & entitlement platform'),
        'emailPlaceholder': ('邮箱', 'Email'),
        'passwordPlaceholder': ('密码', 'Password'),
        'submit': ('登录', 'Sign in'),
        'noAccount': ('还没有开发者账号？', 'No developer account yet?'),
        'register': ('立即注册', 'Sign up'),
        'welcome': ('欢迎, {email}', 'Welcome, {email}'),
        'unverified': ('该邮箱尚未验证。', 'This email has not been verified yet.'),
        'resend': ('重新发送验证码', 'Resend code'),
        'goVerify': ('去完成验证', 'Verify now'),
        'resent': ('验证码已发送，请查收邮件', 'Verification code sent'),
        'resentDev': ('验证码已发送(开发环境: {code})', 'Code sent (dev: {code})'),
    },
    'register': {
        'title': ('注册开发者账号', 'Create a developer account'),
        'verifyTitle': ('验证邮箱', 'Verify your email'),
        'intro': ('注册后立即开通，你会得到独立的开发者空间：自己的应用、授权码与团队成员。',
                  'Your developer space is created immediately — your own apps, license codes and team.'),
        'devNamePlaceholder': ('开发者/团队名称', 'Developer or team name'),
        'emailPlaceholder': ('登录邮箱', 'Login email'),
        'passwordPlaceholder': ('密码(至少 8 位)', 'Password (min 8 chars)'),
        'confirmPlaceholder': ('确认密码', 'Confirm password'),
        'submit': ('注册', 'Sign up'),
        'codeSent': ('验证码已发送到 {email}，15 分钟内有效。',
                     'A code was sent to {email}, valid for 15 minutes.'),
        'devCode': ('开发环境验证码', 'Development code'),
        'codePlaceholder': ('6 位验证码', '6-digit code'),
        'verifySubmit': ('验证并进入', 'Verify and continue'),
        'resend': ('重新发送验证码', 'Resend code'),
        'resendIn': ('重新发送({s}s)', 'Resend ({s}s)'),
        'backToLogin': ('返回登录', 'Back to sign in'),
        'haveAccount': ('已有账号？', 'Already have an account?'),
        'needDevName': ('请填写开发者名称', 'Please enter a developer name'),
        'needPwdLen': ('密码至少 8 位', 'Password must be at least 8 characters'),
        'pwdMismatch': ('两次输入的密码不一致', 'Passwords do not match'),
        'codeLen': ('请输入 6 位验证码', 'Enter the 6-digit code'),
        'registered': ('注册成功，请查收验证码', 'Registered. Check your inbox for the code.'),
        'verified': ('邮箱验证成功，正在进入你的开发者空间',
                     'Email verified. Entering your developer space.'),
        'resentCode': ('验证码已重新发送', 'Verification code resent'),
    },
    'home': {
        'licensesHint': ('查看激活状态、绑定设备和有效期，执行续期、吊销与设备解绑。',
                         'Check activation state, bound devices and expiry; renew, revoke or release devices.'),
    },
}

extra = json.load(io.open('i18n_keys.json', encoding='utf-8'))

zh, en = {}, {}
for ns, kv in BASE.items():
    zh[ns] = {k: v[0] for k, v in kv.items()}
    en[ns] = {k: v[1] for k, v in kv.items()}
for ns, kv in extra.items():
    zh.setdefault(ns, {})
    en.setdefault(ns, {})
    for k, v in kv.items():
        zh[ns][k] = v['zh']
        en[ns][k] = v['en']

# 中英 key 必须完全一致
for ns in sorted(set(zh) | set(en)):
    a, b = set(zh.get(ns, {})), set(en.get(ns, {}))
    assert a == b, (ns, 'zh only:', sorted(a - b), 'en only:', sorted(b - a))

IDENT = re.compile(r'^[A-Za-z_$][A-Za-z0-9_$]*$')


def q(s):
    return json.dumps(s, ensure_ascii=False)


def emit(obj, ind):
    pad = '  ' * ind
    lines = ['{']
    for k, v in obj.items():
        key = k if IDENT.match(k) else q(k)
        if isinstance(v, dict):
            lines.append(f'{pad}  {key}: ' + emit(v, ind + 1) + ',')
        else:
            lines.append(f'{pad}  {key}: {q(v)},')
    lines.append(pad + '}')
    return '\n'.join(lines)


total = sum(len(v) for v in zh.values())
out = f"""/**
 * 界面文案表(中/英)。
 * 生成自 web/i18n_keys.json + 基础文案; 两边 key 必须完全一致。
 * 只翻译界面文案, 接口返回的状态码等仍保持英文原值, 由 label 映射展示。
 */
export const messages = {{
  'zh-CN': {emit(zh, 1)},
  en: {emit(en, 1)},
}} as const;
"""
io.open('src/i18n/messages.ts', 'w', encoding='utf-8', newline='\n').write(out)

# index.ts 只保留初始化与语言切换
idx = """import { createI18n } from 'vue-i18n';
import { messages } from './messages';

export { messages };

/**
 * 界面语言: 默认跟随浏览器, 可手动切换并记住。
 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const STORAGE_KEY = 'lp_locale';

/** 浏览器语言 → 支持的语言; 非中文一律回落英文 */
export function detectLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'zh-CN' || saved === 'en') return saved;
  const nav = navigator.language || 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages,
});

export function currentLocale(): Locale {
  return i18n.global.locale.value as Locale;
}

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.setAttribute('lang', locale);
}
"""
io.open('src/i18n/index.ts', 'w', encoding='utf-8', newline='\n').write(idx)
print('ok', total, 'keys', len(zh), 'namespaces')
