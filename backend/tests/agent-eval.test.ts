import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, leaseNext } from '../src/agents/run-repo';
import { ensureDevUsers } from '../src/auth/dev-users';
import { createMemoryDb } from '../src/db/pglite';
import { loadTraceFiles, runAgentTraces, traceDifference, traceEntry } from '../src/eval/agent-traces';
import { AuditService } from '../src/service';
import { auditor, LENIENT, NEW_ENGAGEMENT, registry } from './helpers';

describe('agent golden traces', () => {
  it('can lease an agent run on the in-process database that eval uses', async () => {
    const db = await createMemoryDb();
    try {
      const svc = new AuditService(db, registry, null, LENIENT);
      await ensureDevUsers(db.kysely);
      const e = await svc.createEngagement(NEW_ENGAGEMENT, auditor);
      const run = await createRun(db.kysely, { engagementId: e.id, startedBy: auditor.id, policy: 'rules', policyVersion: RULES_VERSION, budget: defaultAgentConfig().budget });
      expect(await leaseNext(db.kysely, 'eval', 60_000)).toMatchObject({ id: run.id, takenOver: false });
    } finally {
      await db.close();
    }
  });

  it('compares decisions by action, subject, specialist, mode and policy, never by their reasons', () => {
    expect(traceEntry({ action: { type: 'wait', reason: 'awaiting test results for 3 control(s)' }, rationale: 'r', policy: 'forced', policyVersion: 'v' }))
      .toEqual({ type: 'wait', policy: 'forced' });
    expect(traceEntry({ action: { type: 'rework', specialist: 'scope', subjectKey: 'scope', instruction: 'Add SoD' }, rationale: 'r', policy: 'rules', policyVersion: 'v' }))
      .toEqual({ type: 'rework', subjectKey: 'scope', specialist: 'scope', policy: 'rules' });
    expect(traceEntry({ action: { type: 'request_qa', subjectKey: 'rcm', mode: 'challenge' }, rationale: 'r', policy: 'llm', policyVersion: 'v' }))
      .toEqual({ type: 'request_qa', subjectKey: 'rcm', mode: 'challenge', policy: 'llm' });
    const a = { type: 'complete' as const, policy: 'forced' as const };
    expect(traceDifference([a], [a])).toBeNull();
    expect(traceDifference([a, a], [a])).toBe('decision 2: expected {"policy":"forced","type":"complete"}, got null');
  });

  it('has one scenario per content pack, each with a golden trace that ends at the report gate [REQ-26]', () => {
    const files = loadTraceFiles();
    expect(files.map((f) => f.data.scenario.id).sort()).toEqual(['food-haccp', 'pharma-data-integrity']);
    for (const { data } of files) {
      const types = data.trace.map((t) => t.type);
      expect(types.at(-1)).toBe('open_gate');
      expect(data.trace.at(-1)!.subjectKey).toBe('report');
      // Scope, RCM, one gate per failing control, and the report; never an escalation on the way.
      expect(types.filter((t) => t === 'open_gate')).toHaveLength(3 + data.scenario.failingControls.length);
      expect(types).not.toContain('escalate');
    }
  });

  it('fails a case, rather than passing silently, when the traces directory is missing [REQ-26]', async () => {
    expect(() => loadTraceFiles('/nonexistent/agent-traces')).not.toThrow();
    const results = await runAgentTraces(registry, { dir: '/nonexistent/agent-traces' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'agent:traces-missing', kind: 'agent-trace', passed: false });
    expect(results[0].detail).toContain('/nonexistent/agent-traces');
  });

  it('takes each scenario offline to its report gate with exactly its golden trace [REQ-26]', async () => {
    const results = await runAgentTraces(registry);
    expect(results.map((r) => r.id).sort()).toEqual(['agent:food-haccp', 'agent:pharma-data-integrity']);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  }, 300_000);
});
