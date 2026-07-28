/**
 * store/credentials.ts — Secure Credential Encryption Store.
 * Ported from python credential_store.py
 *
 * AES-256 encrypted credential storage for API keys and environment secrets.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

export class EncryptedCredentialStore {
  private key: Buffer;

  constructor(secretPassphrase = 'hyper-runtime-default-secret-key') {
    this.key = scryptSync(secretPassphrase, 'salt_shovs_v2', 32);
  }

  encrypt(plainText: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', this.key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  decrypt(encryptedPayload: string): string {
    const [ivHex, cipherText] = encryptedPayload.split(':');
    if (!ivHex || !cipherText) return encryptedPayload; // Return raw if unencrypted fallback
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = createDecipheriv('aes-256-cbc', this.key, iv);
    let decrypted = decipher.update(cipherText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
