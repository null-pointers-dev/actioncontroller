import 'server-only';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { getEnv } from '../env';

/**
 * GitHub credentials are never stored in the database. A credential's `secret_ref` is either
 *  - a Key Vault secret name (Azure), or
 *  - "env:NAME" — read from an environment variable (local development only).
 */
const cache = new Map<string, { value: string; at: number }>();
const TTL_MS = 5 * 60_000;
let client: SecretClient | undefined;

function vault(): SecretClient {
  const url = getEnv().KEY_VAULT_URL;
  if (!url) throw new Error('KEY_VAULT_URL is not configured; use "env:NAME" secret references for local development');
  client ??= new SecretClient(url, new DefaultAzureCredential());
  return client;
}

export async function getSecret(ref: string): Promise<string> {
  if (ref.startsWith('env:')) {
    const value = process.env[ref.slice(4)];
    if (!value) throw new Error(`Environment variable ${ref.slice(4)} is empty`);
    return value;
  }
  const hit = cache.get(ref);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const secret = await vault().getSecret(ref);
  if (!secret.value) throw new Error(`Key Vault secret ${ref} has no value`);
  cache.set(ref, { value: secret.value, at: Date.now() });
  return secret.value;
}

/** Stores a secret and returns its reference. "env:NAME" inputs are kept as references. */
export async function storeSecret(name: string, valueOrRef: string): Promise<string> {
  if (valueOrRef.startsWith('env:')) return valueOrRef;
  await vault().setSecret(name, valueOrRef, { contentType: 'github-credential' });
  cache.delete(name);
  return name;
}

export function forgetSecret(ref: string): void {
  cache.delete(ref);
}
