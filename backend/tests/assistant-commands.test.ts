import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import {
  COMMAND_NAMES, COMMANDS, commandNamed, commandsFor, describeCommand, withDefaults,
  type ClauseResult, type CommandContext, type DocumentResult, type EngagementCard, type FindingRow, type PackRow,
} from '../src/assistant/commands';
import { ensureDevUsers } from '../src/auth/dev-users';
import { readTrail } from '../src/db/trail-repo';
import { METHODOLOGY_PACK_ID } from '../src/judgment/standards';
import { insertDocument, setDocumentText, type NewDocument } from '../src/knowledge/document-repo';
import { auditor, engagementWithFailedControl, NEW_ENGAGEMENT, newService, reviewer, viewer } from './helpers';
import type { AuditService } from '../src/service';
import type { User } from '../src/engine/types';

const ctxOf = (svc: AuditService, actor: User): CommandContext => ({ svc, agents: defaultAgentConfig(), actor });
const run = (name: string, ctx: CommandContext, args: unknown, opts = {}) => commandNamed(name)!.run(ctx, commandNamed(name)!.args.parse(args), opts);

describe('the command catalogue (spec §3)', () => {
  it('has no signing command and nothing that acts as the agent [REQ-36]', () => {
    for (const c of COMMANDS) expect(c.name).not.toMatch(/sign|approve|reject/);
    const src = fs.readFileSync(path.resolve(__dirname, '../src/assistant/commands.ts'), 'utf8');
    expect(src).not.toMatch(/signing\/|signGate|signOff|sign-intents|runModuleAsAgent|AgentActing/);
    expect(COMMANDS.map((c) => c.name).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it('shows a viewer only reads and a preparer everything [REQ-36]', () => {
    expect(commandsFor('viewer').every((c) => c.kind === 'read')).toBe(true);
    expect(commandsFor('auditor').map((c) => c.name)).toEqual(expect.arrayContaining(['create_engagement', 'start_run', 'set_tolerance', 'record_management_response', 'set_context']));
    expect(commandsFor('admin')).toEqual([]);
  });

  it('defaults engagementId from the context only when the command needs one', () => {
    expect(withDefaults(commandNamed('list_findings')!, {}, { engagementId: 'ENG-1' })).toEqual({ engagementId: 'ENG-1' });
    expect(withDefaults(commandNamed('list_findings')!, { engagementId: 'ENG-2' }, { engagementId: 'ENG-1' })).toEqual({ engagementId: 'ENG-2' });
    expect(withDefaults(commandNamed('list_packs')!, {}, { engagementId: 'ENG-1' })).toEqual({});
  });

  it('describes every write from its validated args', () => {
    expect(describeCommand('set_tolerance', { engagementId: 'ENG-1', controlId: 'FD-HACCP-03', rate: 0.05 })).toBe('Set the tolerance of FD-HACCP-03 on ENG-1 to 5%');
    expect(describeCommand('set_tolerance', { engagementId: 'ENG-1', controlId: 'C', rate: 0.025 })).toBe('Set the tolerance of C on ENG-1 to 2.5%');
    expect(describeCommand('record_management_response', { engagementId: 'ENG-1', findingId: 'F-1', response: 'agree', owner: 'Plant manager', dueDate: '2026-12-15' })).toBe('Record that management agrees with F-1 on ENG-1, owner Plant manager, due 2026-12-15');
    expect(describeCommand('record_management_response', { engagementId: 'ENG-1', findingId: 'F-1', response: 'partially_agree', owner: 'QA' })).toBe('Record that management partially agrees with F-1 on ENG-1, owner QA');
    expect(describeCommand('create_engagement', NEW_ENGAGEMENT)).toBe('Create engagement "Test audit" for Demo Foods at Plant 1, 2026-01-01 to 2026-06-30, packs food, common');
  });

  it('show_engagement and list_findings read what the engagement page shows', async () => {
    const svc = await newService(); const e = await engagementWithFailedControl(svc);
    const card = (await commandNamed('show_engagement')!.run(ctxOf(svc, viewer), { engagementId: e.id }, {})) as EngagementCard;
    expect(card).toMatchObject({ id: e.id, stage: e.stage, counts: { scopeIncluded: e.scope.filter((s) => s.included).length, rcmRows: e.rcm.length }, opinion: null, openGate: null, run: null, version: e.version });
    expect(card.counts.findings.draft).toBe(e.findings.length);
    expect(card.counts.findings).toEqual({ draft: e.findings.length, blocked: 0, reviewed: 0, approved: 0, rejected: 0 });
    const rows = (await commandNamed('list_findings')!.run(ctxOf(svc, viewer), { engagementId: e.id }, {})) as FindingRow[];
    expect(rows[0]).toMatchObject({ id: e.findings[0].id, title: e.findings[0].title, rating: e.findings[0].rating, status: 'draft', response: null });
  });

  it('find_documents without a query lists newest first within the role\'s classifications, and with a query searches text [REQ-36]', async () => {
    const svc = await newService(); await ensureDevUsers(svc.db.kysely);
    const e = await engagementWithFailedControl(svc); const db = svc.db.kysely;
    const doc = (over: Partial<NewDocument>): NewDocument => ({ sha256: 'a'.repeat(64), filename: 'x.pdf', mime: 'application/pdf', size: 10, kind: 'sop', classification: 'internal', engagementId: null, uploadedBy: 'auditor', ...over });
    const global = await insertDocument(db, doc({ filename: 'SOP-GLOBAL.pdf' }));
    const evidence = await insertDocument(db, doc({ kind: 'evidence', classification: 'restricted', engagementId: e.id, filename: 'CCP-LOG-MAR.xlsx' }));
    await setDocumentText(db, evidence, { extractor: 'test', extractorVersion: '1', text: 'Allergen changeover swab not recorded.' });

    const asViewer = (await run('find_documents', ctxOf(svc, viewer), { engagementId: e.id })) as DocumentResult[];
    expect(asViewer.map((d) => d.kind === 'document' && d.id)).toEqual([global.id]);
    expect(await run('find_documents', ctxOf(svc, viewer), { engagementId: e.id, query: 'allergen' })).toEqual([]);

    const all = (await run('find_documents', ctxOf(svc, reviewer), { engagementId: e.id })) as DocumentResult[];
    expect(all.map((d) => d.kind === 'document' && d.id)).toEqual([evidence.id, global.id]);
    expect(all[0]).toEqual({ kind: 'document', id: evidence.id, filename: 'CCP-LOG-MAR.xlsx', documentKind: 'evidence', snippet: '', href: `/api/documents/${evidence.id}/content` });
    const hits = (await run('find_documents', ctxOf(svc, reviewer), { engagementId: e.id, query: 'allergen', kinds: ['evidence'] })) as DocumentResult[];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'document', id: evidence.id, filename: 'CCP-LOG-MAR.xlsx', href: `/api/documents/${evidence.id}/content` });
  });

  it('search_standards and list_packs leave the methodology pack out unless named', async () => {
    const svc = await newService();
    const packs = (await run('list_packs', ctxOf(svc, viewer), {})) as PackRow[];
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.map((p) => p.id)).not.toContain(METHODOLOGY_PACK_ID);
    expect(Object.keys(packs[0]).sort()).toEqual(['id', 'name', 'version', 'vertical']);
    const clauseIn = (r: ClauseResult[], packId: string) => r.some((c) => svc.registry.packs.get(packId)!.clauses.some((k) => k.id === c.id));
    const plain = (await run('search_standards', ctxOf(svc, viewer), { query: 'internal audit charter' })) as ClauseResult[];
    expect(clauseIn(plain, METHODOLOGY_PACK_ID)).toBe(false);
    const named = (await run('search_standards', ctxOf(svc, viewer), { query: 'internal audit charter', packIds: [METHODOLOGY_PACK_ID] })) as ClauseResult[];
    expect(named.length).toBeGreaterThan(0);
    expect(clauseIn(named, METHODOLOGY_PACK_ID)).toBe(true);
    expect(Object.keys(named[0]).sort()).toEqual(['id', 'ref', 'regulation', 'summary', 'title']);
  });

  it('every write calls through to the service as the actor, with the trail entry and the role check [REQ-36]', async () => {
    const svc = await newService(); await ensureDevUsers(svc.db.kysely);
    const created = (await run('create_engagement', ctxOf(svc, auditor), NEW_ENGAGEMENT)) as { id: string };
    const last = (await readTrail(svc.db.kysely, created.id)).at(-1)!;
    expect(last).toMatchObject({ moduleId: 'human:create-engagement', actor: 'auditor' });
    await expect(run('create_engagement', ctxOf(svc, viewer), NEW_ENGAGEMENT)).rejects.toMatchObject({ status: 403 });

    await svc.runModule(created.id, 'scope', auditor);
    await svc.runModule(created.id, 'rcm', auditor);
    const controlId = (await svc.engagement(created.id)).rcm[0].controlId;
    await run('set_tolerance', ctxOf(svc, auditor), { engagementId: created.id, controlId, rate: 0.05 });
    expect((await svc.engagement(created.id)).tolerances[controlId].rate).toBe(0.05);
    await expect(run('set_tolerance', ctxOf(svc, viewer), { engagementId: created.id, controlId, rate: 0.05 })).rejects.toMatchObject({ status: 403 });

    const started = (await run('start_run', ctxOf(svc, auditor), { engagementId: created.id })) as { run: { status: string } };
    expect(started.run.status).toBe('runnable');
    await expect(run('start_run', ctxOf(svc, viewer), { engagementId: created.id })) .rejects.toMatchObject({ status: 403 });

    const current = (await svc.engagement(created.id)).version!;
    expect(current).toBeGreaterThan(1);
    await expect(run('set_tolerance', ctxOf(svc, auditor), { engagementId: created.id, controlId, rate: 0.04 }, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});
