import crypto from 'node:crypto';
import type { TrailBundle } from './types';

export const GENESIS_HASH = '0'.repeat(64);

/** Stable JSON: object keys sorted so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function hashBundle(bundle: Omit<TrailBundle, 'hash'>): string {
  return sha256(bundle.prevHash + canonicalJson(bundle));
}

export interface ChainTip {
  seq: number;
  hash: string;
}

/** Seals a bundle onto the chain whose last entry is `prev` (null for the first bundle). */
export function seal(prev: ChainTip | null, bundle: Omit<TrailBundle, 'hash' | 'prevHash' | 'seq'>): TrailBundle {
  // Deep copy: the sealed record must not share objects with live working state.
  const unsealed = { ...structuredClone(bundle), seq: prev ? prev.seq + 1 : 1, prevHash: prev ? prev.hash : GENESIS_HASH };
  return { ...unsealed, hash: hashBundle(unsealed) };
}

export interface ChainVerification {
  valid: boolean;
  length: number;
  brokenAt: number | null;
  reason: string | null;
}

/** Recomputes every hash; any edit to a past bundle breaks the chain from there. */
export function verifyChain(chain: TrailBundle[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  for (const [i, b] of chain.entries()) {
    const { hash, ...rest } = b;
    if (b.prevHash !== prevHash) {
      return { valid: false, length: chain.length, brokenAt: b.seq, reason: `Bundle ${b.seq} does not link to bundle ${i}` };
    }
    if (hashBundle(rest) !== hash) {
      return { valid: false, length: chain.length, brokenAt: b.seq, reason: `Bundle ${b.seq} content does not match its hash` };
    }
    prevHash = hash;
  }
  return { valid: true, length: chain.length, brokenAt: null, reason: null };
}
