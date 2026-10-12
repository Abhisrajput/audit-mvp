import YAML from 'yaml';

// OKF concept files: YAML frontmatter between two "---" lines, then a Markdown body.
// YAML 1.2 core schema, so 2027-10-11 stays the string it looks like (no timestamp type).

export interface MarkdownDoc {
  data: Record<string, unknown>;
  body: string;
}

const FENCED = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export function parseMarkdown(text: string, file: string): MarkdownDoc {
  const m = FENCED.exec(text);
  if (!m) throw new Error(`${file}: missing YAML frontmatter (the file must start with a line containing only ---)`);
  let data: unknown;
  try {
    data = YAML.parse(m[1], { schema: 'core', uniqueKeys: true });
  } catch (err) {
    throw new Error(`${file}: invalid YAML frontmatter: ${(err as Error).message.split('\n')[0]}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: frontmatter must be a YAML mapping`);
  return { data: data as Record<string, unknown>, body: (m[2] ?? '').trim() };
}

export function renderMarkdown(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 0, schema: 'core' }).trimEnd();
  return `---\n${yaml}\n---\n${body ? `${body}\n` : ''}`;
}
