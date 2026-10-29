import { createI18n } from 'vue-i18n';

/**
 * 界面语言: 默认跟随浏览器, 可手动切换并记住。
 * 只翻译界面文案; 接口返回的状态码等仍保持英文原值, 通过 label 映射展示。
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

export const messages = {
  'zh-CN': {
    app: { name: '许可控制台', tagline: '授权与许可管理平台' },
    nav: {
      developers: '开发者账号',
      licenses: '授权码',
      catalog: '产品与渠道',
      batches: '批次与发码',
      deviceRequests: '待批准设备',
      customers: '终端客户',
      members: '团队成员',
      reports: '渠道报表',
      audit: '审计日志',
      apiKeys: 'API Key',
      webhooks: 'Webhook',
      groupApp: '我的应用',
      groupSecurity: '安全与集成',
      groupPlatform: '平台管理',
      logout: '退出登录',
      language: '语言',
    },
    common: {
      refresh: '刷新',
      save: '保存',
      cancel: '取消',
      create: '创建',
      edit: '编辑',
      delete: '删除',
      confirm: '确认',
      status: '状态',
      actions: '操作',
      name: '名称',
      email: '邮箱',
      password: '密码',
      none: '不限',
      empty: '暂无数据',
      copied: '已复制',
    },
    login: {
      title: '授权与许可管理平台',
      emailPlaceholder: '邮箱',
      passwordPlaceholder: '密码',
      submit: '登录',
      noAccount: '还没有开发者账号？',
      register: '立即注册',
      welcome: '欢迎, {email}',
      unverified: '该邮箱尚未验证。',
      resend: '重新发送验证码',
      goVerify: '去完成验证',
      resent: '验证码已发送，请查收邮件',
      resentDev: '验证码已发送(开发环境: {code})',
    },
    register: {
      title: '注册开发者账号',
      verifyTitle: '验证邮箱',
      intro: '注册后立即开通，你会得到独立的开发者空间：自己的应用、授权码与团队成员。',
      devNamePlaceholder: '开发者/团队名称',
      emailPlaceholder: '登录邮箱',
      passwordPlaceholder: '密码(至少 8 位)',
      confirmPlaceholder: '确认密码',
      submit: '注册',
      codeSent: '验证码已发送到 {email}，15 分钟内有效。',
      devCode: '开发环境验证码',
      codePlaceholder: '6 位验证码',
      verifySubmit: '验证并进入',
      resend: '重新发送验证码',
      resendIn: '重新发送({s}s)',
      backToLogin: '返回登录',
      haveAccount: '已有账号？',
      needDevName: '请填写开发者名称',
      needPwdLen: '密码至少 8 位',
      pwdMismatch: '两次输入的密码不一致',
      codeLen: '请输入 6 位验证码',
      registered: '注册成功，请查收验证码',
      verified: '邮箱验证成功，正在进入你的开发者空间',
    },
    home: {
      licensesHint: '查看激活状态、绑定设备和有效期，执行续期、吊销与设备解绑。',
    },
  },
  en: {
    app: { name: 'License Console', tagline: 'Licensing & entitlement platform' },
    nav: {
      developers: 'Developer accounts',
      licenses: 'Licenses',
      catalog: 'Products & channels',
      batches: 'Batches & issuing',
      deviceRequests: 'Pending devices',
      customers: 'End customers',
      members: 'Team members',
      reports: 'Channel reports',
      audit: 'Audit log',
      apiKeys: 'API keys',
      webhooks: 'Webhooks',
      groupApp: 'My apps',
      groupSecurity: 'Security & integrations',
      groupPlatform: 'Platform',
      logout: 'Sign out',
      language: 'Language',
    },
    common: {
      refresh: 'Refresh',
      save: 'Save',
      cancel: 'Cancel',
      create: 'Create',
      edit: 'Edit',
      delete: 'Delete',
      confirm: 'Confirm',
      status: 'Status',
      actions: 'Actions',
      name: 'Name',
      email: 'Email',
      password: 'Password',
      none: 'Unlimited',
      empty: 'No data',
      copied: 'Copied',
    },
    login: {
      title: 'Licensing & entitlement platform',
      emailPlaceholder: 'Email',
      passwordPlaceholder: 'Password',
      submit: 'Sign in',
      noAccount: 'No developer account yet?',
      register: 'Sign up',
      welcome: 'Welcome, {email}',
      unverified: 'This email has not been verified yet.',
      resend: 'Resend code',
      goVerify: 'Verify now',
      resent: 'Verification code sent',
      resentDev: 'Code sent (dev: {code})',
    },
    register: {
      title: 'Create a developer account',
      verifyTitle: 'Verify your email',
      intro:
        'Your developer space is created immediately — your own apps, license codes and team.',
      devNamePlaceholder: 'Developer or team name',
      emailPlaceholder: 'Login email',
      passwordPlaceholder: 'Password (min 8 chars)',
      confirmPlaceholder: 'Confirm password',
      submit: 'Sign up',
      codeSent: 'A code was sent to {email}, valid for 15 minutes.',
      devCode: 'Development code',
      codePlaceholder: '6-digit code',
      verifySubmit: 'Verify and continue',
      resend: 'Resend code',
      resendIn: 'Resend ({s}s)',
      backToLogin: 'Back to sign in',
      haveAccount: 'Already have an account?',
      needDevName: 'Please enter a developer name',
      needPwdLen: 'Password must be at least 8 characters',
      pwdMismatch: 'Passwords do not match',
      codeLen: 'Enter the 6-digit code',
      registered: 'Registered. Check your inbox for the code.',
      verified: 'Email verified. Entering your developer space.',
    },
    home: {
      licensesHint:
        'Check activation state, bound devices and expiry; renew, revoke or release devices.',
    },
  },
} as const;

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
