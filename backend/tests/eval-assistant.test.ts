import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_NAMES } from '../src/assistant/commands';
import { ASSISTANT_CASES_FILE, loadAssistantCases, runAssistantCase, runAssistantCases, type AssistantCase } from '../src/eval/assistant';
import { runEval } from '../src/eval/harness';
import { registryFromBundles } from '../src/knowledge/packs';
import { FakeProvider, LENIENT } from './helpers';

const OPTS = { model: 'eval', timeoutMs: 20000 };
const listPacks: AssistantCase = { id: 'x', status: 'draft', description: '', message: 'list packs', expect: { kind: 'command', name: 'list_packs' } };

describe('the assistant eval kind (spec 9)', () => {
  it('loads the draft cases file and every expected command is catalogued', () => {
    const cases = loadAssistantCases();
    expect(cases.filter((c) => !c.needsModel).length).toBeGreaterThanOrEqual(12);
    expect(cases.every((c) => c.status === 'draft' && (c.expect.kind === 'reply' || COMMAND_NAMES.includes(c.expect.name)))).toBe(true);
    expect(ASSISTANT_CASES_FILE).toContain('assistant');
  });

  it('passes a right expectation and fails a wrong one with both names in the detail', async () => {
    expect(await runAssistantCase(listPacks, null, OPTS)).toMatchObject({ passed: true, kind: 'assistant', packId: 'assistant' });
    const bad = await runAssistantCase({ ...listPacks, expect: { kind: 'command', name: 'list_engagements' } }, null, OPTS);
    expect(bad.passed).toBe(false);
    expect(bad.detail).toContain('list_engagements');
    expect(bad.detail).toContain('list_packs');
    const wrongKind = await runAssistantCase({ ...listPacks, expect: { kind: 'reply' } }, null, OPTS);
    expect(wrongKind.passed).toBe(false);
  });

  it('checks every key of the expected args', async () => {
    const show: AssistantCase = { id: 'y', status: 'draft', description: '', message: 'show ENG-1', expect: { kind: 'command', name: 'show_engagement', args: { engagementId: 'ENG-1' } } };
    expect((await runAssistantCase(show, null, OPTS)).passed).toBe(true);
    expect((await runAssistantCase({ ...show, expect: { kind: 'command', name: 'show_engagement', args: { engagementId: 'ENG-9' } } }, null, OPTS)).passed).toBe(false);
  });

  it('every shipped offline case passes against the rules', async () => {
    expect((await runAssistantCases(null)).filter((r) => !r.passed)).toEqual([]);
  });

  it('a missing cases file is one failed row, not a thrown error', async () => {
    const rows = await runAssistantCases(null, '/nonexistent/assistant-cases.json');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'assistant:cases-missing', packId: 'assistant', kind: 'assistant', passed: false, detail: expect.stringContaining('/nonexistent/assistant-cases.json') });
  });

  it('with a model the needsModel cases run and are informational', async () => {
    const llm = new FakeProvider(() => ({ kind: 'reply', say: 'ok' }));
    const rows = await runAssistantCases(llm);
    const all = loadAssistantCases();
    expect(rows).toHaveLength(all.length);
    const modelRows = rows.filter((r) => all.find((c) => c.id === r.id)!.needsModel);
    expect(modelRows).toHaveLength(6);
    expect(modelRows.every((r) => r.informational === true)).toBe(true);
    expect(rows.filter((r) => !modelRows.includes(r)).every((r) => !r.informational)).toBe(true);
  });

  it('a model row fails unless the model answered, and says which outcome it got', async () => {
    const find: AssistantCase = { id: 'm', status: 'draft', description: '', message: 'find the HACCP SOP', needsModel: true, expect: { kind: 'command', name: 'find_documents' } };
    const broken = new FakeProvider(() => { throw new Error('boom'); });
    const failed = await runAssistantCase(find, broken, OPTS);
    expect(failed.passed).toBe(false);
    expect(failed.detail).toContain('outcome: fallback');
    const good = new FakeProvider(() => ({ kind: 'command', name: 'find_documents', args: { query: 'HACCP SOP' }, say: 'Searching.' }));
    const ok = await runAssistantCase(find, good, OPTS);
    expect(ok.passed).toBe(true);
    expect(ok.detail).toContain('outcome: command');
    expect(good.requests[0].model).toBe('eval');
  });

  it('runAssistantCases gives the model the configured planner settings', async () => {
    const llm = new FakeProvider(() => ({ kind: 'reply', say: 'ok' }));
    await runAssistantCases(llm);
    expect(llm.requests.length).toBeGreaterThan(0);
    expect(llm.requests.every((r) => r.model === 'claude-sonnet-5-5' && r.timeoutMs === 20000)).toBe(true);
  });

  it('a null or non-object case is one failed row and the others still run', async () => {
    const file = path.join(os.tmpdir(), `assistant-cases-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify([null, listPacks, 7]));
    try {
      const rows = await runAssistantCases(null, file);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ id: 'assistant:bad-case-0', passed: false });
      expect(rows[1].passed).toBe(true);
      expect(rows[2]).toMatchObject({ id: 'assistant:bad-case-2', passed: false });
    } finally { fs.rmSync(file, { force: true }); }
  });

  it('an offline eval run reports exactly 13 assistant cases', async () => {
    const report = await runEval(registryFromBundles(), null, ['food'], LENIENT.citationPolicy);
    expect(report.byKind.assistant.total).toBe(13);
  });
});
