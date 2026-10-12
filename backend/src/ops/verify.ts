import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import { loadEngagement } from '../db/engagement-repo';
import { lastRevisionTimes } from '../db/revision-repo';
import type { DB } from '../db/schema';
import { listSignatures } from '../db/signature-repo';
import { readTrail } from '../db/trail-repo';
import { verifyChain, type ChainVerification } from '../engine/trail';
import type { SignOff } from '../engine/types';
import { withSignatureStatus } from '../signing/content-hash';
import { BlobNotFound, type BlobStore } from '../storage/blob-store';

// `verify` (spec §7.4, REQ-24): run nightly and after any restore. It reads everything and changes nothing.

export interface IntegrityReport {
  ok: boolean;
  trail: ChainVerification;
  signatures: { checked: number; problems: string[] };
  documents: { checked: number; problems: string[]; skipped: string | null };
}

async function hashStream(stream: Readable): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Each signature row must:
 * - match content the finding actually had (finding_revisions);
 * - match the sign-off bundle sealed with it in the trail.
 * Each live finding's sign-offs must check out against the rows (withSignatureStatus: no broken sign-off, no missing one).
 */
async function checkSignatures(db: Kysely<DB>, trail: Awaited<ReturnType<typeof readTrail>>) {
  const problems: string[] = [];
  const rows = await db.selectFrom('signatures').selectAll().orderBy('signed_at').orderBy('id').execute();
  const history = new Set(
    (await db.selectFrom('finding_revisions').select(['engagement_id', 'finding_id', 'content_hash']).execute()).map((r) => `${r.engagement_id}|${r.finding_id}|${r.content_hash}`),
  );
  const bundles = new Map(trail.map((b) => [b.id, b]));
  for (const s of rows) {
    const label = `Signature ${s.id} (finding ${s.finding_id})`;
    if (!history.has(`${s.engagement_id}|${s.finding_id}|${s.content_hash}`)) problems.push(`${label}: the signed content is not in the finding's history`);
    const b = bundles.get(s.trail_bundle_id);
    const out = b?.output as Partial<SignOff> | undefined;
    if (!b) problems.push(`${label}: its trail entry ${s.trail_bundle_id} is missing`);
    else if (
      b.moduleId !== 'human:sign-off' || b.engagementId !== s.engagement_id || out?.signatureId !== s.id ||
      out?.contentHash !== s.content_hash || out?.userId !== s.user_id || out?.meaning !== s.meaning
    ) problems.push(`${label}: does not match its trail entry`);
  }
  const rowIds = new Set(rows.map((r) => r.id));
  for (const b of trail) {
    const out = b.output as Partial<SignOff> | undefined;
    if (b.moduleId === 'human:sign-off' && out?.signatureId && !rowIds.has(out.signatureId)) {
      problems.push(`Trail entry ${b.id} records signature ${out.signatureId} (finding ${(b.inputs as { findingId?: string } | null)?.findingId ?? 'unknown'}), but the signature row is missing`);
    }
  }
  const engagementIds = (await db.selectFrom('engagements').select('id').orderBy('id').execute()).map((r) => r.id);
  for (const engagementId of engagementIds) {
    const loaded = await loadEngagement(db, engagementId);
    if (!loaded) continue;
    const shown = withSignatureStatus(loaded.engagement, await listSignatures(db, engagementId), await lastRevisionTimes(db, engagementId));
    for (const f of shown.findings) {
      for (const so of f.signOffs) {
        if (so.broken) problems.push(`Finding ${f.id} in ${engagementId}: sign-off ${so.signatureId ?? '(no id)'} (${so.meaning} by ${so.userName}) is broken`);
      }
      for (const issue of f.signatureIssues ?? []) problems.push(`Finding ${f.id} in ${engagementId}: ${issue}`);
    }
  }
  return { checked: rows.length, problems };
}

/** Every registered document's stored bytes, streamed and re-hashed. */
async function checkDocuments(db: Kysely<DB>, blobs: BlobStore) {
  const problems: string[] = [];
  const docs = await db.selectFrom('documents').select(['id', 'sha256', 'size']).orderBy('uploaded_at').orderBy('id').execute();
  for (const d of docs) {
    try {
      const { sha256, size } = await hashStream(await blobs.get(d.sha256));
      if (sha256 !== d.sha256) problems.push(`Document ${d.id}: stored bytes hash to ${sha256}, not ${d.sha256}`);
      else if (size !== Number(d.size)) problems.push(`Document ${d.id}: stored size ${size} bytes, registered ${d.size}`);
    } catch (err) {
      if (err instanceof BlobNotFound) problems.push(`Document ${d.id}: stored file ${d.sha256} is missing`);
      else problems.push(`Document ${d.id}: storage error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { checked: docs.length, problems };
}

export async function verifyIntegrity(db: Kysely<DB>, blobs: BlobStore | null, storageSkipped: string | null = null): Promise<IntegrityReport> {
  const chain = await readTrail(db);
  const trail = verifyChain(chain);
  const signatures = await checkSignatures(db, chain);
  const documents = blobs
    ? { ...(await checkDocuments(db, blobs)), skipped: null }
    : { checked: 0, problems: [], skipped: storageSkipped ?? 'file storage is not configured' };
  const ok = trail.valid && !signatures.problems.length && !documents.problems.length && documents.skipped === null;
  return { ok, trail, signatures, documents };
}
