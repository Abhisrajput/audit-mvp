import { loadCitationPolicy, loadConfig, prepareEnv } from './config';
import { connectPg } from './db';
import { listEngagements } from './db/engagement-repo';
import { createProvider } from './engine/llm/router';
import { loadBundles } from './knowledge/okf/bundle';
import { prepareRegistry } from './knowledge/packs';
import { DEV_USERS } from './auth/dev-users';
import { AuditService } from './service';

// Seeds two fictitious demo engagements (food ingredients + pharma) that walk
// the whole chain, so the UI has something to show. Only seeds an empty
// database. Usage: npm run seed

type Field = [controlId: string, designAdequate: boolean, observation: string, evidence: string[], sample: number, exceptions: number];

async function main() {
  prepareEnv();
  const citationPolicy = loadCitationPolicy();
  const config = loadConfig();
  const db = connectPg(config.databaseUrl, { ssl: config.databaseSsl });
  try {
    if ((await listEngagements(db.kysely)).length) {
      throw new Error('Database already has engagements. Seed only an empty database (locally: docker compose down -v, then migrate).');
    }
    const registry = await prepareRegistry(db, loadBundles(), { production: process.env.NODE_ENV === 'production' });
    const svc = new AuditService(db, registry, createProvider(), { citationPolicy });
    const [auditor, reviewer, approver] = DEV_USERS;

    async function build(meta: Parameters<AuditService['createEngagement']>[0], fields: Field[], approveFirst: number) {
      const e = await svc.createEngagement(meta, auditor);
      await svc.runModule(e.id, 'scope', auditor);
      const wanted = new Set(fields.map((f) => f[0]));
      const scoped = await svc.engagement(e.id);
      await svc.setScope(e.id, scoped.scope.map((s) => ({ controlId: s.controlId, included: s.included || wanted.has(s.controlId) })), auditor);
      await svc.runModule(e.id, 'rcm', auditor);
      for (const [id, design, obs, ev, n, x] of fields) {
        await svc.recordTest(e.id, id, { designAdequate: design, observation: obs, evidenceRefs: ev, sampleTested: n, exceptions: x }, auditor);
      }
      await svc.runModule(e.id, 'testing', auditor);
      await svc.runModule(e.id, 'gaps', auditor);
      const ready = (await svc.engagement(e.id)).findings.filter((f) => f.status === 'draft');
      for (const f of ready.slice(0, approveFirst + 1)) await svc.signOff(e.id, f.id, 'review', 'Condition and criteria agreed to workpapers.', reviewer, {}, { unattended: 'seed' });
      for (const f of ready.slice(0, approveFirst)) await svc.signOff(e.id, f.id, 'approve', 'Agreed with management at exit meeting.', approver, {}, { unattended: 'seed' });
      await svc.runModule(e.id, 'report', auditor);
      return svc.engagement(e.id);
    }

    const food = await build(
      {
        name: 'H1 2026 Food Safety & Commodity Risk Audit',
        entity: 'Demo Ingredients Pvt Ltd (fictitious)',
        site: 'Cocoa & coffee processing plant, Pune',
        periodFrom: '2026-01-01',
        periodTo: '2026-06-30',
        auditType: 'Food safety and treasury internal audit',
        scopeStatement:
          'HACCP verification for cocoa roasting and coffee lines (CCP monitoring, corrective actions, record review), supplier approval of cocoa and coffee bean suppliers, traceability and mock recall readiness, allergen changeover, and commodity hedging controls: positions against limits, trade confirmations and hedge documentation.',
        packIds: ['food', 'common'],
      },
      [
        ['FD-HACCP-03', true, '4 of 20 roaster CCP temperature logs were unsigned by the operator; two had readings recorded after the shift ended.', ['CCP-LOG-ROAST-MAR-2026', 'Shift roster March'], 20, 4],
        ['FD-HACCP-04', true, 'All 6 CCP deviations in the period had product held and QA disposition recorded.', ['DEV-LOG-H1'], 6, 0],
        ['FD-SUP-01', true, '3 of 25 cocoa bean receipts were from a supplier whose approval expired in February; COAs present but no aflatoxin verification test.', ['ASL-2026', 'GRN sample listing'], 25, 3],
        ['FD-TRC-02', true, 'Mock recall in May traced 100% of the lot in 3h 10m against a 4h target.', ['MOCK-RECALL-2026-05'], 1, 0],
        ['FD-ALG-01', false, 'Changeover cleaning for the hazelnut line is not verified; no allergen swab or visual sign-off is required by the SOP.', ['SOP-ALG-004 v2'], 0, 0],
        ['CMN-TRS-02', true, 'On 2 of 30 sampled days the coffee net position exceeded the volume limit and the breach was not escalated to the risk committee.', ['Daily position reports Apr-May'], 30, 2],
        ['CMN-TRS-03', true, 'All 40 sampled futures trades agreed to broker confirmations.', ['Broker confirmations Q2'], 40, 0],
      ],
      2,
    );

    const pharma = await build(
      {
        name: 'Q3 2026 GMP Self-Inspection — Oral Solids',
        entity: 'Demo Pharma Ltd (fictitious)',
        site: 'OSD manufacturing site, Baddi',
        periodFrom: '2026-04-01',
        periodTo: '2026-09-30',
        auditType: 'GMP self-inspection',
        scopeStatement:
          'Data integrity of QC laboratory systems (HPLC audit trails, user access, shared accounts), OOS investigations, deviation and CAPA effectiveness, and batch record review before release.',
        packIds: ['pharma'],
      },
      [
        ['PH-DI-01', true, 'Audit trail review not documented for 5 of 20 HPLC sequences before result approval.', ['HPLC sequence list Q2', 'Empower audit trail export'], 20, 5],
        ['PH-DI-02', false, 'Generic "LAB" shared account in use on two dissolution testers; analysts hold administrator rights on Empower.', ['User list DISSO-01/02', 'Empower role matrix'], 0, 0],
        ['PH-DEV-01', true, '3 of 15 deviations were closed without assessing impact on other batches made on the same granulator.', ['Deviation log 2026'], 15, 3],
        ['PH-BR-01', true, 'All 20 sampled batch records complete, signed and reviewed by QA before release.', ['BMR sample listing'], 20, 0],
        ['PH-CAPA-01', true, 'Effectiveness checks for 2 of 10 closed CAPAs lacked defined criteria; one issue recurred.', ['CAPA register'], 10, 2],
      ],
      1,
    );

    console.log(`Seeded ${food.id} (${food.findings.length} findings) and ${pharma.id} (${pharma.findings.length} findings)`);
    console.log('Trail:', await svc.verifyTrail());
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
