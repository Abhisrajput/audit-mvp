import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PACKS_DIR, loadBundle, loadBundles } from '../src/knowledge/okf/bundle';
import { parseControlBody, renderControlBody } from '../src/knowledge/okf/control-body';
import { parseMarkdown, renderMarkdown } from '../src/knowledge/okf/frontmatter';
import { loadLegacyPack, packToFiles } from '../src/knowledge/okf/migrate-json';
import { slugOf } from '../src/knowledge/okf/schema';
import { bundleToContentPack } from '../src/knowledge/okf/to-pack';
import { demoRoot, expectedAfterMigration, FIXTURE, tmpRoot, withoutTrust, writeBundle } from './okf-fixtures';

describe('OKF frontmatter', () => {
  it('round-trips YAML frontmatter and keeps dates as strings', () => {
    const text = renderMarkdown({ type: 'clause', title: 'T', stale_after: '2027-10-11', x_audit: { id: 'A.1' } }, 'Body text.');
    expect(text.startsWith('---\n')).toBe(true);
    const doc = parseMarkdown(text, 'x.md');
    expect(doc.data).toEqual({ type: 'clause', title: 'T', stale_after: '2027-10-11', x_audit: { id: 'A.1' } });
    expect(doc.body).toBe('Body text.');
    expect(parseMarkdown('---\nat: 2026-10-11\nn: 3\n---\n', 'y.md').data).toEqual({ at: '2026-10-11', n: 3 });
  });

  it('rejects files without frontmatter or with a non-mapping frontmatter', () => {
    expect(() => parseMarkdown('# Just markdown', 'a.md')).toThrow(/a\.md: missing YAML frontmatter/);
    expect(() => parseMarkdown('---\n- a\n- b\n---\n', 'b.md')).toThrow(/b\.md: frontmatter must be a YAML mapping/);
    expect(() => parseMarkdown('---\ntitle: [unclosed\n---\n', 'c.md')).toThrow(/c\.md: invalid YAML frontmatter/);
  });
});

describe('control bodies', () => {
  const body = { objective: 'O.', testOfDesign: ['a', 'b'], testOfEffectiveness: ['c'], checklist: [], recommendation: 'R.' };

  it('round-trips the five sections', () => {
    expect(parseControlBody(renderControlBody(body), 'k.md')).toEqual(body);
  });

  it('rejects missing, reordered or malformed sections', () => {
    expect(() => parseControlBody('## Objective\nO.\n\n## Recommendation\nR.', 'k.md')).toThrow(/k\.md: control body must have the sections/);
    expect(() => parseControlBody(renderControlBody({ ...body, objective: '' }), 'k.md')).toThrow(/"## Objective" is empty/);
    expect(() => parseControlBody(renderControlBody(body).replace('- a', 'a'), 'k.md')).toThrow(/"## Test of design" must be a list of "- " items/);
    expect(() => parseControlBody(renderControlBody({ ...body, testOfDesign: [] }), 'k.md')).toThrow(/"## Test of design" needs at least one item/);
    expect(() => parseControlBody(`Intro\n${renderControlBody(body)}`, 'k.md')).toThrow(/text before the first "## Objective"/);
  });
});

describe('OKF bundles', () => {
  it('converts a pack to a bundle and back without losing anything', () => {
    const root = demoRoot();
    expect(fs.readdirSync(path.join(root, 'demo')).sort()).toEqual(['clauses', 'controls', 'eval', 'pack.md']);
    expect(fs.existsSync(path.join(root, 'demo/clauses/ds-2.md'))).toBe(true);
    const bundle = loadBundle(root, 'demo');
    expect(bundle.version).toBe('0.2.0');
    expect(bundle.classification).toBe('internal');
    expect(bundle.sha256).toMatch(/^[a-f0-9]{64}$/);
    const pack = bundleToContentPack(bundle);
    expect(withoutTrust(pack)).toEqual(expectedAfterMigration(FIXTURE));
    expect(pack.clauses.find((c) => c.id === 'DS-2')!.trust).toEqual({
      nodeId: 'demo/clause/ds-2', verifiedBy: null, verifiedRole: null, verifiedAt: null, status: 'active',
      staleAfter: '2027-10-11', sourcePath: 'demo/clauses/ds-2.md',
    });
  });

  it('turns control sources into cites edges and body links into relates_to edges', () => {
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace('Review records monthly.', 'Review records monthly; see [the policy](../clauses/ds-1.md).')));
    const control = loadBundle(root, 'demo').concepts.find((c) => c.conceptId === 'DM-01')!;
    expect(control.links).toEqual([
      { target: 'demo/clause/ds-2', rel: 'cites', ref: '/clauses/ds-2.md' },
      { target: 'demo/clause/ds-1', rel: 'cites', ref: '/clauses/ds-1.md' },
      { target: 'demo/clause/ds-1', rel: 'relates_to', ref: '../clauses/ds-1.md' },
    ]);
  });

  it('rejects a link to a concept that does not exist, naming the file and the link', () => {
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace('/clauses/ds-1.md', '/clauses/ds-9.md')));
    expect(() => loadBundle(root, 'demo')).toThrow(/demo\/controls\/dm-01\.md: link "\/clauses\/ds-9\.md" points to "demo\/clauses\/ds-9\.md", which is not a concept in this bundle/);
  });

  it('rejects a link that leaves the pack', () => {
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace('/clauses/ds-1.md', '../../food/clauses/x.md')));
    expect(() => loadBundle(root, 'demo')).toThrow(/demo\/controls\/dm-01\.md: link "\.\.\/\.\.\/food\/clauses\/x\.md" points outside the pack/);
  });

  it('requires clause_refs to name exactly the clauses a control links to', () => {
    const root = demoRoot((f) => f.set('controls/dm-01.md', f.get('controls/dm-01.md')!.replace(/    - DS-1\n/, '')));
    expect(() => loadBundle(root, 'demo')).toThrow(/demo\/controls\/dm-01\.md: x_audit\.clause_refs \(DS-2\) must name exactly the clauses in sources \(DS-1, DS-2\)/);
  });

  it('rejects misplaced, misnamed, mistyped and unknown content', () => {
    const misnamed = demoRoot((f) => { f.set('clauses/other-name.md', f.get('clauses/ds-1.md')!); f.delete('clauses/ds-1.md'); });
    expect(() => loadBundle(misnamed, 'demo')).toThrow(/demo\/clauses\/other-name\.md: file name must be "ds-1\.md" \(the slug of x_audit\.id "DS-1"\)/);

    const wrongFolder = demoRoot((f) => f.set('controls/ds-1.md', f.get('clauses/ds-1.md')!));
    expect(() => loadBundle(wrongFolder, 'demo')).toThrow(/demo\/controls\/ds-1\.md: type "clause" does not match its folder \(expected "control"\)/);

    const typo = demoRoot((f) => f.set('clauses/ds-1.md', f.get('clauses/ds-1.md')!.replace('status: active', 'status: active\nstale_afer: 2027-01-01')));
    expect(() => loadBundle(typo, 'demo')).toThrow(/demo\/clauses\/ds-1\.md: invalid frontmatter: .*stale_afer/);

    const stray = demoRoot((f) => f.set('notes/todo.md', '---\ntype: clause\n---\n'));
    expect(() => loadBundle(stray, 'demo')).toThrow(/demo\/notes: not part of an OKF bundle/);

    const noPack = demoRoot((f) => f.delete('pack.md'));
    expect(() => loadBundle(noPack, 'demo')).toThrow(/demo: missing pack\.md/);
  });

  it('rejects the same concept id in two bundles', () => {
    const root = demoRoot();
    const copy = packToFiles({ ...FIXTURE, id: 'demo2', controls: [], evalCases: [], clauses: [FIXTURE.clauses[1]] });
    writeBundle(root, 'demo2', copy);
    expect(() => loadBundles(root)).toThrow(/clause "DS-1" is defined twice: demo\/clauses\/ds-1\.md and demo2\/clauses\/ds-1\.md/);
  });

  it('slugs concept ids for file names', () => {
    expect(slugOf('21CFR211.22')).toBe('21cfr211-22');
    expect(slugOf('PH-QU-01')).toBe('ph-qu-01');
    expect(slugOf('EU-GMP-Annex11 §4.8')).toBe('eu-gmp-annex11-4-8');
  });
});

describe('the migrated MVP packs', () => {
  for (const id of ['common', 'food', 'pharma']) {
    it(`${id}: pack.json converts losslessly and matches the committed bundle`, () => {
      const legacy = loadLegacyPack(path.join(DEFAULT_PACKS_DIR, id, 'pack.json'));
      const files = packToFiles(legacy);
      const root = tmpRoot();
      writeBundle(root, id, files);
      expect(withoutTrust(bundleToContentPack(loadBundle(root, id)))).toEqual(expectedAfterMigration(legacy));
      for (const [rel, text] of files) expect(fs.readFileSync(path.join(DEFAULT_PACKS_DIR, id, rel), 'utf8'), rel).toBe(text);
    });
  }
});
