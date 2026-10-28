import crypto from 'node:crypto';

/** AES-256-GCM 信封: 输出 Buffer = iv(12) | authTag(16) | ciphertext */
export function encryptAead(secret: string | Buffer, plaintext: string): Buffer {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptAead(secret: string | Buffer, blob: Buffer): string {
  const key = deriveKey(secret);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function deriveKey(secret: string | Buffer): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}
