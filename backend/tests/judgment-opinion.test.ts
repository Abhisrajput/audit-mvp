import { describe, expect, it } from 'vitest';
import { approvedFindingsFingerprint, OPINIONS, opinionBasisText, opinionOf, parseOpinionDirective, worsens } from '../src/judgment/opinion';
import { reportMemo, reviseCallByPerson } from '../src/judgment/memo';
import { finding } from './agent-fixtures';

describe('the engagement opinion (spec §5.6) [REQ-32]', () => {
  it('is unsatisfactory on any approved High, needs improvement on any Medium, else satisfactory, over approved findings only', () => {
    expect(opinionOf([])).toBe('satisfactory');
    expect(opinionOf([finding('a', 'approved', { rating: 'Low' })])).toBe('satisfactory');
    expect(opinionOf([finding('a', 'approved', { rating: 'Medium' }), finding('b', 'approved', { rating: 'Low' })])).toBe('needs_improvement');
    expect(opinionOf([finding('a', 'approved', { rating: 'High' }), finding('b', 'approved', { rating: 'Medium' })])).toBe('unsatisfactory');
    expect(opinionOf([finding('a', 'draft', { rating: 'High' }), finding('b', 'reviewed', { rating: 'High' })])).toBe('satisfactory');
  });
  it('orders opinions from best to worst and worsens only strictly', () => {
    expect(OPINIONS).toEqual(['satisfactory', 'needs_improvement', 'unsatisfactory']);
    expect(worsens('satisfactory', 'needs_improvement')).toBe(true);
    expect(worsens('needs_improvement', 'needs_improvement')).toBe(false);
    expect(worsens('unsatisfactory', 'satisfactory')).toBe(false);
  });
  it('parses an opinion directive from a rejection comment, reports an unknown value, and ignores comments without one', () => {
    expect(parseOpinionDirective('Too harsh. opinion: needs_improvement')).toEqual({ opinion: 'needs_improvement' });
    expect(parseOpinionDirective('OPINION: Unsatisfactory, see the CAPA backlog')).toEqual({ opinion: 'unsatisfactory' });
    expect(parseOpinionDirective('opinion: good')).toMatchObject({ problem: expect.stringContaining('good') });
    expect(parseOpinionDirective('Bring the allergen controls into scope')).toBeNull();
  });
  it('writes the fixed basis paragraph with counts, coverage and rows tested', () => {
    const text = opinionBasisText({
      approved: [finding('a', 'approved', { rating: 'High' }), finding('b', 'approved', { rating: 'Low' })],
      coverage: { excluded: [{ processArea: 'Allergen control', reason: 'excluded by the scope statement' }], statement: 's' },
      rowsTested: 9, rowsInScope: 10, areasCovered: ['Food safety – HACCP', 'Supplier approval'],
    });
    expect(text).toContain('2 approved finding(s): 1 High, 0 Medium, 1 Low');
    expect(text).toContain('9 of 10 in-scope controls were tested');
    expect(text).toContain('Food safety – HACCP, Supplier approval');
    expect(text).toContain('Allergen control (excluded by the scope statement)');
    expect(opinionBasisText({ approved: [], coverage: null, rowsTested: 0, rowsInScope: 0, areasCovered: [] })).toContain('No coverage statement was recorded');
  });
  it('fingerprints the approved findings by id and content hash, in id order, ignoring other statuses', () => {
    const a = finding('a', 'approved'), b = finding('b', 'approved'), d = finding('d', 'draft');
    expect(approvedFindingsFingerprint([b, a, d])).toBe(approvedFindingsFingerprint([a, b]));
    expect(approvedFindingsFingerprint([a, { ...b, condition: 'changed' }])).not.toBe(approvedFindingsFingerprint([a, b]));
  });
});

describe('the report memo [REQ-31]', () => {
  const base = { ruleOpinion: 'needs_improvement' as const, approved: [{ id: 'F1', rating: 'Medium' as const }], responses: {}, coverage: null, tolerances: [], iia: { verified: 0, total: 16 }, notes: [], producedAt: 't' };
  it('names the opinion call with its source and standard, the responses recorded, the coverage and the methodology status', () => {
    const memo = reportMemo({ ...base, opinion: { rating: 'needs_improvement', basis: 'b', findingsFingerprint: 'x' }, source: 'rules' });
    expect(memo.subjectKey).toBe('report');
    const opinion = memo.calls.find((c) => c.question === 'Overall opinion')!;
    expect(opinion).toMatchObject({ decision: 'needs_improvement', source: 'rules', standard: ['IIA-14.5'] });
    expect(memo.calls.map((c) => c.question)).toEqual(['Overall opinion', 'Management responses', 'Coverage and methodology']);
    expect(memo.forTheReviewer).toContain('1 approved finding(s) have no management response recorded; the CAE signs once the auditor has recorded them all.');
    expect(memo.forTheReviewer.some((l) => l.includes('0 of 16'))).toBe(true);
  });
  it('marks a CAE-set opinion as the person\'s call, naming the signature and the rule\'s value', () => {
    const memo = reportMemo({ ...base, opinion: { rating: 'satisfactory', basis: 'b', setBy: 'SIG-1', findingsFingerprint: 'x' }, source: 'person' });
    const opinion = memo.calls.find((c) => c.question === 'Overall opinion')!;
    expect(opinion.source).toBe('person');
    expect(opinion.rationale).toContain('SIG-1');
    expect(opinion.rationale).toContain('needs_improvement');
  });
  it('a call revised by a person is marked person', () => {
    const memo = reportMemo({ ...base, opinion: { rating: 'needs_improvement', basis: 'b', findingsFingerprint: 'x' }, source: 'rules' });
    expect(reviseCallByPerson(memo, 'Overall opinion', 'x', 'u').calls[0].source).toBe('person');
  });
});
