import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Classification } from '../access';
import { parseControlBody } from './control-body';
import { parseMarkdown } from './frontmatter';
import { CONCEPT_DIRS, CONCEPT_SCHEMAS, slugOf, type ConceptType, type ControlAttrs, type PackAttrs } from './schema';

// Loads OKF bundles from backend/packs/<pack-id>/ (spec §6.2): validates every file, resolves
// links between concepts, and returns the concepts with their content hashes for the compiler.

export const DEFAULT_PACKS_DIR = path.resolve(__dirname, '../../../packs');

export class BundleError extends Error {}

export interface ConceptLink {
  /** Node id of the linked concept. */
  target: string;
  rel: 'cites' | 'relates_to';
  /** The link as written in the file. */
  ref: string;
}

export interface Concept {
  /** "<pack>/<type>/<slug>"; the pack itself is "<pack>/pack/<pack>". */
  nodeId: string;
  type: ConceptType;
  packId: string;
  /** x_audit.id: the id engagements, findings and eval cases store. */
  conceptId: string;
  /** Relative to the packs directory, forward slashes: "pharma/clauses/21cfr211-22.md". */
  path: string;
  /** SHA-256 of the file's bytes. */
  sha256: string;
  title: string;
  description: string | null;
  body: string;
  tags: string[];
  /** OKF sources exactly as written: concept links (.md) and external URLs. */
  sources: { ref: string }[];
  /** The validated x_audit block. */
  attrs: Record<string, unknown>;
  generated: { by: string; at: string } | null;
  verified: { by: string; role: string; at: string } | null;
  status: 'active' | 'deprecated';
  staleAfter: string | null;
  /** http(s) sources. */
  externalSources: string[];
  links: ConceptLink[];
}

export interface Bundle {
  packId: string;
  version: string;
  classification: Classification;
  /** SHA-256 over the sorted "<path> <sha256>" lines of every file: the bundle's exact content. */
  sha256: string;
  /** The pack concept first, then the others ordered by path. */
  concepts: Concept[];
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
export const EXTERNAL = /^https?:\/\//;
const BODY_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** The fields every concept schema shares; x_audit is otherwise type-specific. */
interface CommonFields {
  title: string;
  description?: string;
  tags: string[];
  sources: { ref: string }[];
  generated: Concept['generated'];
  verified: Concept['verified'];
  status: Concept['status'];
  stale_after: string | null;
  x_audit: { id: string } & Record<string, unknown>;
}

interface RawConcept extends Omit<Concept, 'links'> {
  linkRefs: { ref: string; rel: ConceptLink['rel'] }[];
}

function readConcept(packsDir: string, packId: string, rel: string, type: ConceptType): RawConcept {
  const file = `${packId}/${rel}`;
  const bytes = fs.readFileSync(path.join(packsDir, packId, rel));
  const doc = parseMarkdown(bytes.toString('utf8'), file);
  if (doc.data.type !== type) throw new BundleError(`${file}: type "${String(doc.data.type)}" does not match its folder (expected "${type}")`);
  const parsed = CONCEPT_SCHEMAS[type].safeParse(doc.data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}${'keys' in i ? ` (${(i as { keys: string[] }).keys.join(', ')})` : ''}`);
    throw new BundleError(`${file}: invalid frontmatter: ${issues.join('; ')}`);
  }
  const data = parsed.data as CommonFields;
  const conceptId = data.x_audit.id;
  if (type === 'pack') {
    if (conceptId !== packId) throw new BundleError(`${file}: x_audit.id "${conceptId}" must equal the folder name "${packId}"`);
  } else if (path.posix.basename(rel) !== `${slugOf(conceptId)}.md`) {
    throw new BundleError(`${file}: file name must be "${slugOf(conceptId)}.md" (the slug of x_audit.id "${conceptId}")`);
  }
  if (type === 'control') parseControlBody(doc.body, file);

  const linkRefs: RawConcept['linkRefs'] = [];
  const externalSources: string[] = [];
  for (const { ref } of data.sources) {
    if (EXTERNAL.test(ref)) externalSources.push(ref);
    else if (ref.endsWith('.md')) linkRefs.push({ ref, rel: 'cites' });
    else throw new BundleError(`${file}: source "${ref}" is neither a link to a concept (.md) nor an http(s) URL`);
  }
  for (const m of doc.body.matchAll(BODY_LINK)) {
    if (m[1].endsWith('.md')) linkRefs.push({ ref: m[1], rel: 'relates_to' });
  }

  return {
    nodeId: `${packId}/${type}/${type === 'pack' ? packId : slugOf(conceptId)}`,
    type, packId, conceptId, path: file, sha256: sha256(bytes),
    title: data.title, description: data.description ?? null, body: doc.body, tags: data.tags, sources: data.sources,
    attrs: data.x_audit, generated: data.generated, verified: data.verified, status: data.status,
    staleAfter: data.stale_after, externalSources, linkRefs,
  };
}

/** Resolves a link to a path inside the pack, or null when it points outside it. */
function resolveLink(fromRel: string, ref: string): string | null {
  const target = ref.startsWith('/')
    ? path.posix.normalize(ref.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), ref));
  return target === '..' || target.startsWith('../') || target.startsWith('/') ? null : target;
}

export function loadBundle(packsDir: string, packId: string): Bundle {
  const root = path.join(packsDir, packId);
  const files: { rel: string; type: ConceptType }[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile() && entry.name === 'pack.md') {
      files.push({ rel: 'pack.md', type: 'pack' });
      continue;
    }
    const type = entry.isDirectory() ? CONCEPT_DIRS[entry.name as keyof typeof CONCEPT_DIRS] : undefined;
    if (!type) throw new BundleError(`${packId}/${entry.name}: not part of an OKF bundle (expected pack.md and the folders ${Object.keys(CONCEPT_DIRS).join(', ')})`);
    for (const f of fs.readdirSync(path.join(root, entry.name), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (f.name.startsWith('.')) continue; // .DS_Store and the like, as at the bundle root
      if (!f.isFile() || !f.name.endsWith('.md')) throw new BundleError(`${packId}/${entry.name}/${f.name}: only .md concept files belong in ${entry.name}/`);
      files.push({ rel: `${entry.name}/${f.name}`, type });
    }
  }
  if (!files.some((f) => f.type === 'pack')) throw new BundleError(`${packId}: missing pack.md`);

  const raw = files.map((f) => readConcept(packsDir, packId, f.rel, f.type));
  const byPath = new Map(raw.map((c) => [c.path.slice(packId.length + 1), c]));

  const concepts: Concept[] = raw.map(({ linkRefs, ...c }) => {
    const links: ConceptLink[] = [];
    for (const { ref, rel } of linkRefs) {
      const resolved = resolveLink(c.path.slice(packId.length + 1), ref);
      if (resolved === null) throw new BundleError(`${c.path}: link "${ref}" points outside the pack (links must stay inside ${packId}/)`);
      const target = byPath.get(resolved);
      if (!target) throw new BundleError(`${c.path}: link "${ref}" points to "${packId}/${resolved}", which is not a concept in this bundle`);
      if (!links.some((l) => l.target === target.nodeId && l.rel === rel)) links.push({ target: target.nodeId, rel, ref });
    }
    return { ...c, links };
  });

  for (const c of concepts.filter((x) => x.type === 'control')) {
    const linked = [...new Set(c.links.filter((l) => l.rel === 'cites').map((l) => concepts.find((x) => x.nodeId === l.target)!).filter((x) => x.type === 'clause').map((x) => x.conceptId))].sort();
    const refs = [...new Set((c.attrs as ControlAttrs).clause_refs)].sort();
    if (linked.join('|') !== refs.join('|')) {
      throw new BundleError(`${c.path}: x_audit.clause_refs (${refs.join(', ')}) must name exactly the clauses in sources (${linked.join(', ')})`);
    }
  }

  const pack = concepts.find((c) => c.type === 'pack')!;
  const attrs = pack.attrs as PackAttrs;
  return {
    packId,
    version: attrs.version,
    classification: attrs.classification,
    sha256: sha256(concepts.map((c) => `${c.path} ${c.sha256}`).sort().join('\n')),
    concepts: [pack, ...concepts.filter((c) => c !== pack)],
  };
}

/** Every bundle under the packs directory, ordered by pack id. Concept ids must be unique per type across bundles. */
export function loadBundles(packsDir = DEFAULT_PACKS_DIR): Bundle[] {
  const bundles = fs
    .readdirSync(packsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .map((id) => loadBundle(packsDir, id));
  const seen = new Map<string, string>();
  for (const c of bundles.flatMap((b) => b.concepts)) {
    if (c.type === 'pack') continue;
    const key = `${c.type}:${c.conceptId}`;
    if (seen.has(key)) throw new BundleError(`${c.type} "${c.conceptId}" is defined twice: ${seen.get(key)} and ${c.path}`);
    seen.set(key, c.path);
  }
  return bundles;
}
