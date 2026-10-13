import { describe, expect, it } from 'vitest';
import { defaultAgentConfig } from '../src/agents/config';
import { RULES_VERSION } from '../src/agents/policy/rules';
import { createRun, leaseNext } from '../src/agents/run-repo';
import { ensureDevUsers } from '../src/auth/dev-users';
import { createMemoryDb } from '../src/db/pglite';
import { INFORMATIONAL_LLM_BUDGET, loadTraceFiles, runAgentTraces, traceDifference, traceEntry, type ScenarioRunner } from '../src/eval/agent-traces';
import { evalArgs, tallyCases } from '../src/eval/harness';
import type { Budget } from '../src/agents/types';
import type { LlmProvider } from '../src/engine/llm/provider';
import { AuditService } from '../src/service';
import { auditor, FakeProvider, LENIENT, NEW_ENGAGEMENT, registry } from './helpers';

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

  describe('informational model-driven runs', () => {
    const model = new FakeProvider(() => { throw new Error('no model in tests'); });
    // Golden runs replay their stored trace; model runs throw, as a paid run that goes wrong might.
    function scripted() {
      const calls: { scenario: string; llm: LlmProvider | null; budget?: Budget }[] = [];
      const runScenario: ScenarioRunner = async (_registry, scenario, llm, budget) => {
        calls.push({ scenario: scenario.id, llm, budget });
        if (llm) throw new Error('model run blew up');
        const golden = loadTraceFiles().find((f) => f.data.scenario.id === scenario.id)!;
        return { trace: golden.data.trace, reachedReportGate: true, detail: 'reached the report gate' };
      };
      return { calls, runScenario };
    }

    it('reports an error in a model run under its own informational case, never failing the golden case', async () => {
      const { calls, runScenario } = scripted();
      const results = await runAgentTraces(registry, { llm: model, runScenario });
      expect(results.map((r) => r.id)).toEqual(['agent:food-haccp', 'agent-llm:food-haccp', 'agent:pharma-data-integrity', 'agent-llm:pharma-data-integrity']);
      const golden = results.filter((r) => r.id.startsWith('agent:'));
      expect(golden.every((r) => r.passed && !r.informational)).toBe(true);
      const info = results.filter((r) => r.id.startsWith('agent-llm:'));
      for (const r of info) expect(r).toMatchObject({ kind: 'agent-trace-llm', informational: true, passed: false, detail: expect.stringContaining('model run blew up') });
      // Model runs get a budget of their own, far below a production run's.
      expect(calls.filter((c) => c.llm).map((c) => c.budget)).toEqual([INFORMATIONAL_LLM_BUDGET, INFORMATIONAL_LLM_BUDGET]);
      expect(INFORMATIONAL_LLM_BUDGET).toMatchObject({ maxCostUsd: 2, maxTokens: 200_000 });
    });

    it('runs no model-driven scenario unless a model is passed for them', async () => {
      const { calls, runScenario } = scripted();
      const results = await runAgentTraces(registry, { runScenario });
      expect(results.map((r) => r.id)).toEqual(['agent:food-haccp', 'agent:pharma-data-integrity']);
      expect(calls.every((c) => c.llm === null)).toBe(true);
    });

    it('asks for model-driven runs only with --agent-llm, not because a provider is given', () => {
      expect(evalArgs(['--provider', 'anthropic'])).toEqual({ provider: 'anthropic', packs: undefined, updateTraces: false, agentLlm: false });
      expect(evalArgs(['--provider', 'anthropic', '--agent-llm', '--packs', 'food,pharma'])).toEqual({ provider: 'anthropic', packs: ['food', 'pharma'], updateTraces: false, agentLlm: true });
      expect(evalArgs([])).toEqual({ provider: 'offline', packs: undefined, updateTraces: false, agentLlm: false });
    });

    it('leaves informational cases out of the totals', () => {
      const tally = tallyCases([
        { id: 'agent:a', packId: 'food', kind: 'agent-trace', description: '', passed: true, detail: '' },
        { id: 'agent-llm:a', packId: 'food', kind: 'agent-trace-llm', description: '', passed: true, informational: true, detail: '' },
        { id: 'agent-llm:b', packId: 'food', kind: 'agent-trace-llm', description: '', passed: false, informational: true, detail: '' },
      ]);
      expect(tally).toEqual({ total: 1, passed: 1, byKind: { 'agent-trace': { total: 1, passed: 1 } } });
    });
  });
});
