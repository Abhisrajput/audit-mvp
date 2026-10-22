import { api } from './api';
import type { CommandKind, CommandName, CommandResponse, HistoryTurn, ShownItem, TurnResponse } from './types';

// The chat assistant as the panel uses it. Everything here is plain functions over the API's types, so it is tested
// without a browser; the panel only lays it out.

export interface AssistantSettings {
  enabled: boolean;
  planner: 'llm' | 'rules';
  commands: { name: CommandName; kind: CommandKind; description: string }[];
}

export const assistantApi = {
  settings: () => api<AssistantSettings>('/assistant/settings'),
  turn: (body: { message: string; context: { engagementId?: string; shown?: ShownItem[] }; history: HistoryTurn[] }) =>
    api<TurnResponse>('/assistant/turns', { method: 'POST', body }),
  // The server's command body is strict: send exactly these keys, whatever object (a proposal with a summary) is handed in.
  confirm: (proposal: { name: CommandName; args: unknown; expectedVersion?: number }) =>
    api<CommandResponse>('/assistant/commands', {
      method: 'POST',
      body: { name: proposal.name, args: proposal.args, ...(proposal.expectedVersion !== undefined ? { expectedVersion: proposal.expectedVersion } : {}) },
    }),
};

export interface Turn {
  id: number;
  message: string;
  response: TurnResponse | null;
  error: string | null;
  done: { summary: string } | null;
  cancelled: boolean;
  /** A confirm request is in flight. Kept on the turn, not in the card, so a remount cannot offer Confirm again. */
  pending: boolean;
}

export const confirmStarted = (t: Turn): Turn => ({ ...t, pending: true });
export const confirmFailed = (t: Turn): Turn => ({ ...t, pending: false });

/** The most history entries (person and assistant lines together) sent with a turn. */
export const HISTORY_TURNS = 8;
const SHOWN_MAX = 20;
const LABEL_MAX = 80;

export function trimHistory(turns: Turn[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const t of turns) {
    if (!t.response) continue;
    out.push({ role: 'person', text: t.message }, { role: 'assistant', text: t.response.say });
  }
  return out.slice(-HISTORY_TURNS);
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const item = (kind: ShownItem['kind'], id: unknown, label: unknown): ShownItem[] =>
  typeof id === 'string' && typeof label === 'string' ? [{ kind, id, label: label.slice(0, LABEL_MAX) }] : [];
const each = (result: unknown, f: (r: Rec) => ShownItem[]): ShownItem[] => (Array.isArray(result) ? result.filter(isRec).flatMap(f) : []);

/** What a read result put on screen, so the next turn can say "the second one". */
export function shownFrom(name: CommandName, result: unknown): ShownItem[] {
  let items: ShownItem[];
  switch (name) {
    case 'list_engagements': items = each(result, (r) => item('engagement', r.id, r.name)); break;
    case 'show_engagement': items = isRec(result) ? item('engagement', result.id, result.name) : []; break;
    case 'list_findings': items = each(result, (r) => item('finding', r.id, r.title)); break;
    case 'find_documents':
      items = each(result, (r) => (r.kind === 'concept' ? item('document', r.conceptId, r.title) : item('document', r.id, r.filename)));
      break;
    case 'search_standards': items = each(result, (r) => item('clause', r.id, r.title)); break;
    default: items = [];
  }
  return items.slice(0, SHOWN_MAX);
}

export const ARG_LABELS: Record<string, string> = {
  engagementId: 'Engagement', name: 'Name', entity: 'Entity', site: 'Site', periodFrom: 'Period from', periodTo: 'Period to',
  auditType: 'Audit type', scopeStatement: 'Scope statement', packIds: 'Packs', controlId: 'Control', rate: 'Tolerance',
  findingId: 'Finding', response: 'Response', owner: 'Owner', dueDate: 'Due date', actionPlan: 'Action plan', factors: 'Factors',
  background: 'Background', query: 'Query', kinds: 'Kinds',
};

function argValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (key === 'rate' && typeof value === 'number') return `${Math.round(value * 1000) / 10}%`;
  if (Array.isArray(value)) {
    return value.some(isRec) ? `${value.length} factor(s)` : value.map(String).join(', ');
  }
  return String(value);
}

export function argRows(args: unknown): { label: string; value: string }[] {
  if (!isRec(args)) return [];
  return Object.entries(args).map(([key, value]) => ({ label: ARG_LABELS[key] ?? key, value: argValue(key, value) }));
}

export function engagementIdOf(_name: CommandName, args: unknown): string | null {
  return isRec(args) && typeof args.engagementId === 'string' && args.engagementId !== '' ? args.engagementId : null;
}

/** A confirmed write tells the rest of the app which engagement changed, so open views can reload. */
export const assistantEvents = new EventTarget();

export function notifyChanged(engagementId: string): void {
  assistantEvents.dispatchEvent(new CustomEvent('changed', { detail: { engagementId } }));
}

export function onChanged(handler: (engagementId: string) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<{ engagementId: string }>).detail.engagementId);
  assistantEvents.addEventListener('changed', listener);
  return () => assistantEvents.removeEventListener('changed', listener);
}

export const OFFLINE_HINT = 'Offline: I understand a few fixed phrases — list engagements; show ENG-…; list findings; find documents about …; search standards for …; list packs; start the run.';

/** Retriever snippets carry highlight markup; show them as plain text. */
export function plainSnippet(text: string): string {
  return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
