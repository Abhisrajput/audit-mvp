import fs from 'node:fs';
import path from 'node:path';
import { LegacyPackSchema } from '../knowledge/okf/migrate-json';
import type { Clause, ContentPack, Control } from './types';

// Content packs are data, not code: a new vertical or regulation set is added by
// dropping a pack.json into packs/<id>/. LegacyPackSchema (knowledge/okf/migrate-json.ts) is the contract.

export const DEFAULT_PACKS_DIR = path.resolve(__dirname, '../../packs');

export class PackRegistry {
  readonly packs = new Map<string, ContentPack>();
  readonly clauses = new Map<string, Clause & { packId: string }>();
  readonly controls = new Map<string, Control & { packId: string }>();

  constructor(packs: ContentPack[]) {
    for (const pack of packs) this.add(pack);
    this.checkReferences();
  }

  static loadFromDir(dir = DEFAULT_PACKS_DIR): PackRegistry {
    const packs: ContentPack[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name, 'pack.json');
      if (!entry.isDirectory() || !fs.existsSync(file)) continue;
      const parsed = LegacyPackSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!parsed.success) {
        throw new Error(`Invalid content pack ${file}: ${parsed.error.message}`);
      }
      packs.push(parsed.data as ContentPack);
    }
    return new PackRegistry(packs);
  }

  private add(pack: ContentPack) {
    if (this.packs.has(pack.id)) throw new Error(`Duplicate pack id ${pack.id}`);
    this.packs.set(pack.id, pack);
    for (const c of pack.clauses) {
      if (this.clauses.has(c.id)) throw new Error(`Duplicate clause id ${c.id}`);
      this.clauses.set(c.id, { ...c, packId: pack.id });
    }
    for (const c of pack.controls) {
      if (this.controls.has(c.id)) throw new Error(`Duplicate control id ${c.id}`);
      this.controls.set(c.id, { ...c, packId: pack.id });
    }
  }

  /** Every control must cite clauses that exist somewhere in the loaded corpus. */
  private checkReferences() {
    for (const control of this.controls.values()) {
      for (const ref of control.clauseRefs) {
        if (!this.clauses.has(ref)) {
          throw new Error(`Control ${control.id} cites unknown clause ${ref}`);
        }
      }
    }
  }

  get(id: string): ContentPack {
    const pack = this.packs.get(id);
    if (!pack) throw new Error(`Unknown pack ${id}`);
    return pack;
  }

  list(): ContentPack[] {
    return [...this.packs.values()];
  }

  /** Display label for a clause: "§211.192" stands alone; otherwise prefix the source's short name. */
  citationLabel(clauseId: string): string {
    const c = this.clauses.get(clauseId);
    if (!c) return clauseId;
    if (c.ref.startsWith('§')) return c.ref;
    const short = this.get(c.packId).sources[c.regulation] ?? c.regulation;
    return `${short} ${c.ref}`;
  }

  versions(packIds: string[]): Record<string, string> {
    return Object.fromEntries(packIds.map((id) => [id, this.get(id).version]));
  }

  controlsFor(packIds: string[]) {
    return [...this.controls.values()].filter((c) => packIds.includes(c.packId));
  }

  /** Clauses reachable from the given packs: their own plus any they cite. */
  clausesFor(packIds: string[]) {
    const ids = new Set<string>();
    for (const c of this.clauses.values()) if (packIds.includes(c.packId)) ids.add(c.id);
    for (const ctl of this.controlsFor(packIds)) ctl.clauseRefs.forEach((r) => ids.add(r));
    return [...ids].map((id) => this.clauses.get(id)!);
  }
}
