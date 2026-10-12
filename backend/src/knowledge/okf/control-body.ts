// A control's body: five "## " sections in a fixed order. Objective and Recommendation are prose;
// the other three are "- " lists (the checklist may be empty).

export const CONTROL_SECTIONS = ['Objective', 'Test of design', 'Test of effectiveness', 'Checklist', 'Recommendation'] as const;

export interface ControlBody {
  objective: string;
  testOfDesign: string[];
  testOfEffectiveness: string[];
  checklist: string[];
  recommendation: string;
}

export function parseControlBody(body: string, file: string): ControlBody {
  const parts = body.split(/^## /m);
  if (parts[0].trim()) throw new Error(`${file}: text before the first "## Objective" heading`);
  const sections = parts.slice(1).map((p) => {
    const nl = p.indexOf('\n');
    return { heading: (nl < 0 ? p : p.slice(0, nl)).trim(), content: nl < 0 ? '' : p.slice(nl + 1).trim() };
  });
  const found = sections.map((s) => s.heading);
  if (found.join('|') !== CONTROL_SECTIONS.join('|')) {
    const want = CONTROL_SECTIONS.map((h) => `"## ${h}"`).join(', ');
    throw new Error(`${file}: control body must have the sections ${want} in that order (found ${found.map((h) => `"## ${h}"`).join(', ') || 'none'})`);
  }
  const prose = (i: number) => {
    if (!sections[i].content) throw new Error(`${file}: "## ${CONTROL_SECTIONS[i]}" is empty`);
    return sections[i].content;
  };
  const list = (i: number, required: boolean) => {
    const lines = sections[i].content.split('\n').map((l) => l.trim()).filter(Boolean);
    const bad = lines.find((l) => !l.startsWith('- '));
    if (bad) throw new Error(`${file}: "## ${CONTROL_SECTIONS[i]}" must be a list of "- " items (found "${bad}")`);
    const items = lines.map((l) => l.slice(2).trim());
    if (items.some((x) => !x)) throw new Error(`${file}: "## ${CONTROL_SECTIONS[i]}" has an empty item`);
    if (required && !items.length) throw new Error(`${file}: "## ${CONTROL_SECTIONS[i]}" needs at least one item`);
    return items;
  };
  return { objective: prose(0), testOfDesign: list(1, true), testOfEffectiveness: list(2, true), checklist: list(3, false), recommendation: prose(4) };
}

export function renderControlBody(b: ControlBody): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
  return [
    '## Objective', b.objective, '',
    '## Test of design', list(b.testOfDesign), '',
    '## Test of effectiveness', list(b.testOfEffectiveness), '',
    '## Checklist', list(b.checklist), '',
    '## Recommendation', b.recommendation,
  ].join('\n');
}
