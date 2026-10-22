import { describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { argRows, assistantApi, plainSnippet, engagementIdOf, notifyChanged, onChanged, shownFrom, trimHistory, type Turn } from './assistant';

vi.mock('./api', () => ({ api: vi.fn(async () => ({})) }));

const turn = (id: number, over: Partial<Turn> = {}): Turn => ({
  id, message: `q${id}`, response: { say: `a${id}` }, error: null, done: null, cancelled: false, ...over,
});

describe('trimHistory', () => {
  it('keeps the last 8 entries, person then assistant per answered turn', () => {
    const out = trimHistory([1, 2, 3, 4, 5, 6].map((i) => turn(i)));
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual({ role: 'person', text: 'q3' });
    expect(out[7]).toEqual({ role: 'assistant', text: 'a6' });
  });
  it('skips turns without a response', () => {
    const out = trimHistory([turn(1), turn(2, { response: null, error: 'boom' }), turn(3)]);
    expect(out.map((h) => h.text)).toEqual(['q1', 'a1', 'q3', 'a3']);
  });
});

describe('shownFrom', () => {
  it('cuts finding titles to 80 and keeps at most 20', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `F-${i}`, title: 'x'.repeat(100), rating: 'high', status: 'draft', response: null }));
    const out = shownFrom('list_findings', rows);
    expect(out).toHaveLength(20);
    expect(out[0]).toEqual({ kind: 'finding', id: 'F-0', label: 'x'.repeat(80) });
  });
  it('maps engagements, documents, concepts and clauses', () => {
    expect(shownFrom('list_engagements', [{ id: 'ENG-1', name: 'FY26' }])).toEqual([{ kind: 'engagement', id: 'ENG-1', label: 'FY26' }]);
    expect(shownFrom('show_engagement', { id: 'ENG-1', name: 'FY26' })).toEqual([{ kind: 'engagement', id: 'ENG-1', label: 'FY26' }]);
    expect(shownFrom('find_documents', [{ kind: 'document', id: 'D-1', filename: 'a.pdf' }, { kind: 'concept', conceptId: 'C-1', title: 'Cold chain' }]))
      .toEqual([{ kind: 'document', id: 'D-1', label: 'a.pdf' }, { kind: 'document', id: 'C-1', label: 'Cold chain' }]);
    expect(shownFrom('search_standards', [{ id: 'CL-1', title: 'Hygiene' }])).toEqual([{ kind: 'clause', id: 'CL-1', label: 'Hygiene' }]);
  });
  it('gives nothing for packs, writes and unexpected shapes', () => {
    expect(shownFrom('list_packs', [{ id: 'food', name: 'Food' }])).toEqual([]);
    expect(shownFrom('create_engagement', { id: 'ENG-2', name: 'n' })).toEqual([]);
    expect(shownFrom('list_findings', { not: 'an array' })).toEqual([]);
    expect(shownFrom('show_engagement', [1])).toEqual([]);
  });
});

describe('argRows', () => {
  it('labels, formats the rate and joins arrays in key order', () => {
    expect(argRows({ engagementId: 'ENG-1', rate: 0.05, packIds: ['food', 'common'] })).toEqual([
      { label: 'Engagement', value: 'ENG-1' }, { label: 'Tolerance', value: '5%' }, { label: 'Packs', value: 'food, common' },
    ]);
  });
  it('counts factors, blanks nulls and falls back to the key', () => {
    expect(argRows({ factors: [{ a: 1 }, { a: 2 }], owner: null, mystery: 7 })).toEqual([
      { label: 'Factors', value: '2 factor(s)' }, { label: 'Owner', value: '' }, { label: 'mystery', value: '7' },
    ]);
    expect(argRows(null)).toEqual([]);
  });
});

describe('engagementIdOf', () => {
  it('returns a non-empty string engagementId, else null', () => {
    expect(engagementIdOf('show_engagement', { engagementId: 'ENG-1' })).toBe('ENG-1');
    expect(engagementIdOf('show_engagement', { engagementId: '' })).toBeNull();
    expect(engagementIdOf('show_engagement', { engagementId: 3 })).toBeNull();
    expect(engagementIdOf('list_packs', null)).toBeNull();
  });
});

describe('onChanged', () => {
  it('receives the id and stops after unsubscribe', () => {
    const seen: string[] = [];
    const off = onChanged((id) => seen.push(id));
    notifyChanged('ENG-1');
    off();
    notifyChanged('ENG-2');
    expect(seen).toEqual(['ENG-1']);
  });
});

describe('assistantApi.confirm', () => {
  it('posts only name, args and expectedVersion', async () => {
    await assistantApi.confirm({ name: 'start_run', args: { engagementId: 'E1' }, expectedVersion: 3, summary: 'x' } as never);
    expect(vi.mocked(api).mock.calls.at(-1)![1]!.body).toEqual({ name: 'start_run', args: { engagementId: 'E1' }, expectedVersion: 3 });
    await assistantApi.confirm({ name: 'start_run', args: {}, summary: 'x' } as never);
    expect(Object.keys(vi.mocked(api).mock.calls.at(-1)![1]!.body as object).sort()).toEqual(['args', 'name']);
  });
});

describe('plainSnippet', () => {
  it('strips tags and collapses whitespace', () => {
    expect(plainSnippet('<b>allergen</b> and\n  physical <i>hazards</i>')).toBe('allergen and physical hazards');
  });
});
