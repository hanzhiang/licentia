import net from 'node:net';
import tls from 'node:tls';
import type { NotificationChannel, DeliveryResult } from './channel';
import { ok, fail } from './channel';
import type { RenderedMessage } from './templates';

/**
 * 最小 SMTP 客户端(不加依赖): EHLO → STARTTLS → AUTH PLAIN → MAIL/RCPT/DATA → QUIT.
 * 只实现投递所需的子集; 不支持 SMTPUTF8/DSN/多收件人分批(调用方按收件人逐条投递).
 *
 * 为什么不用 nodemailer: 平台其余部分零外部依赖倾向(见 sdks/ts), 这里只需单收件人纯文本.
 */
export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  /** 发件人 */
  from: string;
  /** 强制 TLS(465) 还是 STARTTLS(587); true 时从连接起就是 TLS */
  implicitTls?: boolean;
  timeoutMs?: number;
}

const CRLF = '\r\n';

class SmtpSession {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = '';
  private waiters: Array<(line: string) => void> = [];

  constructor(private readonly opts: SmtpOptions, socket?: net.Socket | tls.TLSSocket) {
    this.socket = socket ?? this.openSocket();
    this.attach(this.socket);
  }

  private openSocket(): net.Socket | tls.TLSSocket {
    const { host, port, implicitTls, timeoutMs = 10_000 } = this.opts;
    const s = implicitTls
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    s.setTimeout(timeoutMs, () => s.destroy(new Error('SMTP_TIMEOUT')));
    return s;
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      // SMTP 多行响应: 以 "250-" 续行, "250 " 结束
      let idx: number;
      while ((idx = this.buffer.indexOf(CRLF)) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + CRLF.length);
        if (line.length >= 4 && line[3] === '-') continue; // 续行, 继续等结束行
        const waiter = this.waiters.shift();
        waiter?.(line);
      }
    });
    socket.on('error', (e) => {
      const waiter = this.waiters.shift();
      waiter?.(`-1 ${e.message}`);
    });
  }

  /** 读一行响应; 以 "-1 " 前缀表示传输层错误 */
  read(): Promise<string> {
    if (this.buffer.includes(CRLF)) {
      const idx = this.buffer.indexOf(CRLF);
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + CRLF.length);
      return Promise.resolve(line);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async cmd(line: string, expectPrefixes: string[]): Promise<string> {
    this.socket.write(line + CRLF);
    const res = await this.read();
    if (res.startsWith('-1 ')) throw new Error(res.slice(3));
    if (!expectPrefixes.some((p) => res.startsWith(p))) {
      throw new Error(`SMTP_UNEXPECTED: ${line.split(' ')[0]} -> ${res}`);
    }
    return res;
  }

  /** STARTTLS: 升级现有 socket, 重新挂监听 */
  async upgrade(): Promise<void> {
    const { host } = this.opts;
    this.socket.removeAllListeners('data');
    this.buffer = '';
    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: this.socket, servername: host }, () => resolve(s));
      s.on('error', reject);
    });
    this.socket = secured;
    secured.setTimeout(this.opts.timeoutMs ?? 10_000, () =>
      secured.destroy(new Error('SMTP_TIMEOUT')),
    );
    this.attach(secured);
  }

  write(data: string): void {
    this.socket.write(data);
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

export class SmtpEmailChannel implements NotificationChannel {
  readonly name = 'email' as const;

  constructor(private readonly opts: SmtpOptions) {}

  async send(target: { to: string }, message: RenderedMessage): Promise<DeliveryResult> {
    let session: SmtpSession | null = null;
    try {
      session = new SmtpSession(this.opts);
      const greeting = await session.read();
      if (!greeting.startsWith('220')) throw new Error(`SMTP_GREETING: ${greeting}`);

      const host = this.opts.host;
      await session.cmd(`EHLO ${host}`, ['250']);
      if (!this.opts.implicitTls) {
        await session.cmd('STARTTLS', ['220']);
        await session.upgrade();
        await session.cmd(`EHLO ${host}`, ['250']);
      }
      if (this.opts.user) {
        const token = Buffer.from(`\0${this.opts.user}\0${this.opts.pass ?? ''}`, 'utf8').toString(
          'base64',
        );
        await session.cmd(`AUTH PLAIN ${token}`, ['235']);
      }

      await session.cmd(`MAIL FROM:<${this.opts.from}>`, ['250']);
      await session.cmd(`RCPT TO:<${target.to}>`, ['250', '251']);
      await session.cmd('DATA', ['354']);

      const data = [
        `From: ${this.opts.from}`,
        `To: ${target.to}`,
        `Subject: ${encodeHeader(message.subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(Buffer.from(message.text, 'utf8').toString('base64')),
      ].join(CRLF);
      session.write(data + CRLF + '.' + CRLF);
      const accepted = await session.read();
      if (!accepted.startsWith('250')) throw new Error(`SMTP_DATA: ${accepted}`);
      await session.cmd('QUIT', ['221']).catch(() => undefined);
      return ok(null);
    } catch (e) {
      return fail(e);
    } finally {
      session?.close();
    }
  }
}

/** RFC 2047 编码非 ASCII 主题 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrapBase64(b64: string): string {
  return b64.replace(/.{1,76}/g, (m) => m + CRLF).trimEnd();
}

/**
 * 短信通道: HTTP 网关(阿里云/腾讯云等国内网关均为「POST 表单/JSON + 签名」形态).
 * 平台只定义契约, endpoint/密钥由部署侧配置; 未配置时通道不可用(通道选择见 index.ts).
 */
export interface SmsGatewayOptions {
  endpoint: string;
  /** 请求头(含鉴权), 由部署侧建; 平台不落库明文密钥 */
  headers?: Record<string, string>;
  /** 网关字段名映射: 默认 { phone: 'phone', text: 'text' } */
  fields?: { phone: string; text: string };
  timeoutMs?: number;
}

export class HttpSmsChannel implements NotificationChannel {
  readonly name = 'sms' as const;

  constructor(private readonly opts: SmsGatewayOptions) {}

  async send(target: { to: string }, message: RenderedMessage): Promise<DeliveryResult> {
    const text = message.sms ?? message.text;
    const fields = this.opts.fields ?? { phone: 'phone', text: 'text' };
    const body = JSON.stringify({ [fields.phone]: target.to, [fields.text]: text });
    try {
      const res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.headers ?? {}) },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      const raw = await res.text().catch(() => '');
      if (!res.ok) return fail(new Error(`SMS_HTTP_${res.status}: ${raw.slice(0, 200)}`));
      let providerMessageId: string | null = null;
      try {
        const parsed = JSON.parse(raw) as { id?: string; message_id?: string };
        providerMessageId = parsed.id ?? parsed.message_id ?? null;
      } catch {
        // 网关返回非 JSON 也算成功(只有 HTTP 状态是契约)
      }
      return ok(providerMessageId);
    } catch (e) {
      return fail(e);
    }
  }
}

/** 测试/离线环境: 不真的发, 但保持「已投递」语义可观测(记录到 stdout) */
export class ConsoleChannel implements NotificationChannel {
  readonly name: 'email' | 'sms';

  constructor(name: 'email' | 'sms' = 'email') {
    this.name = name;
  }

  async send(target: { to: string }, message: RenderedMessage): Promise<DeliveryResult> {
    console.log(
      `[notify:${this.name}] to=${target.to} subject=${JSON.stringify(message.subject)} ` +
        `text=${JSON.stringify(message.text.slice(0, 200))}`,
    );
    return ok(`console-${Date.now()}`);
  }
}
