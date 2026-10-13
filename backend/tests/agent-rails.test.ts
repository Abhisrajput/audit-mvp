import { describe, expect, it } from 'vitest';
import { assertWithinRails } from '../src/agents/rails';
import type { SignOff } from '../src/engine/types';
import { engagement, finding, input, row } from './agent-fixtures';

const signOff: SignOff = { userId: 'reviewer', userName: 'R', role: 'reviewer', meaning: 'Reviewed', comment: '', at: 't' };
const base = () => engagement({ rcm: [row('R1')], testInputs: { R1: input() }, findings: [finding('R1')] });

describe('assertWithinRails', () => {
  it('passes an untouched engagement [REQ-27]', () => {
    expect(() => assertWithinRails(base(), base())).not.toThrow();
  });

  it('refuses a changed, added or removed test input [REQ-27]', () => {
    const changed = base();
    changed.testInputs.R1.exceptions = 9;
    const added = base();
    added.testInputs.R2 = input();
    const removed = base();
    delete removed.testInputs.R1;
    for (const after of [changed, added, removed]) expect(() => assertWithinRails(base(), after)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
  });

  it('refuses a sign-off added to an existing draft finding [REQ-27]', () => {
    const after = base();
    after.findings[0].signOffs.push(signOff);
    expect(() => assertWithinRails(base(), after)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
  });

  it('refuses a new finding that already carries a sign-off [REQ-27]', () => {
    const after = base();
    after.findings.push(finding('R2', 'draft', { signOffs: [signOff] }));
    expect(() => assertWithinRails(base(), after)).toThrow(expect.objectContaining({ code: 'AGENT_FORBIDDEN' }));
  });
});
