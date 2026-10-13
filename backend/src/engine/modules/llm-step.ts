import type { z } from 'zod';
import { AppError } from '../../errors';
import { asData, DATA_RULES } from '../llm/prompt';
import type { ModuleContext } from '../module';
import { sha256 } from '../trail';

export const SYSTEM_PREAMBLE = `You are a drafting assistant inside an internal-audit platform for regulated manufacturers.
You draft; a qualified human auditor reviews and signs off. Rules:
- Use only the facts, controls and clauses given in the request. Do not invent evidence, numbers, names or dates.
- Cite regulations only by the clause IDs supplied. Never cite a clause that is not in the list.
- Write in plain, factual audit language. No speculation about intent.`;

/**
 * Asks the configured model for a structured draft. Returns null when no model
 * is configured or the call fails, in which case the module uses its
 * deterministic path. Either way the prompt hash and outcome go into the trail.
 * Every module prompt carries people's text only inside <data> blocks (asData), so the system
 * prompt always includes DATA_RULES. A redraft an agent asked for carries the reviewer's feedback, as data.
 */
export async function askModel<T>(ctx: ModuleContext, system: string, user: string, schema: z.ZodType<T>): Promise<T | null> {
  if (!ctx.llm) return null;
  const feedback = typeof ctx.input.reworkInstruction === 'string' ? ctx.input.reworkInstruction.trim() : '';
  const fullSystem = `${system}\n${DATA_RULES}`;
  const fullUser = feedback
    ? `${user}\n\nA reviewer asked for this redraft. Address their feedback where the facts given allow it:\n${asData('reviewer-feedback', feedback)}`
    : user;
  ctx.promptHash = sha256(fullSystem + '\n---\n' + fullUser);
  ctx.step('model', `Requesting draft from ${ctx.llm.id}/${ctx.llm.model}`);
  try {
    const res = await ctx.llm.generate({ system: fullSystem, user: fullUser, schema });
    ctx.servedModel = res.servedModel;
    ctx.step('model', `Draft received from ${res.servedModel}`);
    return res.output;
  } catch (err) {
    // A refused budget or a lost lease is not a model failure: it stops the work instead of falling back.
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    ctx.step('model', `Model call failed: ${msg}. Falling back to deterministic rules.`);
    ctx.gate({ gate: 'model-availability', outcome: 'warn', target: 'module', detail: msg, action: 'flagged' });
    return null;
  }
}
