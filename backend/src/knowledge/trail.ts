import crypto from 'node:crypto';
import type { Transaction } from 'kysely';
import type { DB } from '../db/schema';
import { appendTrail } from '../db/trail-repo';
import type { User } from '../engine/types';
import { ENGINE_VERSION } from '../service';
import type { DocumentRecord } from './document-repo';

/** Seals a document registration into the audit trail, in the caller's transaction. */
export async function recordDocumentEvent(trx: Transaction<DB>, actor: User, doc: DocumentRecord, chunks: number) {
  const now = new Date().toISOString();
  return appendTrail(trx, {
    id: `DOC-EVT-${crypto.randomBytes(4).toString('hex')}`,
    engagementId: doc.engagementId,
    moduleId: 'document:register',
    moduleVersion: ENGINE_VERSION,
    engineVersion: ENGINE_VERSION,
    packVersions: {},
    provider: { id: 'human', model: actor.id },
    promptHash: null,
    actor: actor.id,
    startedAt: now,
    finishedAt: now,
    inputs: { documentId: doc.id, sha256: doc.sha256, kind: doc.kind, classification: doc.classification },
    retrievalSet: [],
    executionLog: [{ at: now, step: 'document:register', detail: `${actor.name} (${actor.role})` }],
    qaActions: [],
    output: { chunks },
  });
}
