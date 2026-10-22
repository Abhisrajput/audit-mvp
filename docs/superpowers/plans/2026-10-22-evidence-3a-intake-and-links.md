# Evidence Management 3A: Intake and Links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload evidence from the product, extract its text on the server, cite documents and pages from test records and findings, run retention, and show it all on an Evidence tab.

**Architecture:** A new `backend/src/evidence/` module (sniffing, extractors, the extraction runner, the upload and text routes, links, retention) sits beside the existing `knowledge/` registry and reuses its repository, chunking, retriever and trail recorder. Extraction status is an append-only `document_extractions` log. Evidence links are a new optional `evidence` array on `TestInput` and `Finding`, validated against the registry at write time, hashed only when present, beside the kept free-text `evidenceRefs`. The frontend gains an Evidence tab, an upload client, a document picker and status chips.

**Tech Stack:** Node 22 / TypeScript (CommonJS, `module: nodenext`) / Express 5 / Kysely / Postgres (pglite in tests) / zod 4 / vitest + supertest; React 18 / MUI 5 / Vite. New dependencies, exactly these: `busboy` (+ `@types/busboy` dev), `pdfjs-dist` 6, `mammoth` 1.13, `exceljs` 4.4.

**Spec:** `docs/superpowers/specs/2026-10-22-evidence-management-design.md` (§§1–8, 10–12 are 3A; §9 is 3B and out of this plan)

## Global Constraints

- Backward compatibility is exact: no existing column changes meaning; a finding without `evidence` hashes byte-for-byte as before; both golden agent traces stay byte-identical; pre-3A engagements load unchanged.
- Nothing is deleted: `documents`, `document_text`, `chunks`, `blob_uploads` and the new `document_extractions` are append-only; `retention_expired` is the only mutable document field, and only the owner role flips it.
- The extractor's input is always the stored bytes read back from the blob store by `sha256` (REQ-38).
- `evidenceRefs: string[]` stays on `TestInput` and `Finding`; `evidence?: EvidenceLink[]` is added beside it; an empty `evidence` array is normalised to absent before storing or hashing.
- Uploads are buffered in memory up to `BLOB_MAX_BYTES` (25 MiB default; production cap 100 MiB unchanged) and stored through the existing `BlobStore.put(bytes, { mime })`.
- Roles: `PREPARER_ROLES` upload, retry and link; `READ_ROLES` read lists, text and usage within `CLASSIFICATIONS_BY_ROLE`; admin sees nothing.
- Limits: `EXTRACT_MAX_BYTES` default = `BLOB_MAX_BYTES`; `EXTRACT_TIMEOUT_MS` 30000; `ZIP_MAX_UNCOMPRESSED_BYTES` 256 MiB; `MAX_TEXT_CHARS` 900 000 (existing); `uploadsPerMinute: 10`; note ≤ 500 chars; link note ≤ 200 chars; ≤ 50 links per record.
- Error codes added to `ErrorCode`: `UPLOAD_TOO_LARGE` (413), `CONTENT_MISMATCH` (400), `EVIDENCE_NOT_FOUND` (400), `EVIDENCE_EXPIRED` (400), `EXTRACTION_EXISTS` (409), `UNSUPPORTED` (409), `DUPLICATE_DIFFERS` (409).
- Requirements: REQ-38 (High), REQ-39 (High), REQ-40 (Medium) in `backend/validation/requirements.json`, tagged `[REQ-nn]` in test titles; traceability must stay fully covered.
- Commit messages end with `Co-Authored-By: <your model name> <noreply@anthropic.com>`. Never push.

## Review Focus

1. A part over `BLOB_MAX_BYTES` → 413 `UPLOAD_TOO_LARGE`, and neither a blob nor a document row exists afterwards → Task 3 test "a part over the cap is 413 and nothing is stored or registered".
2. A declared `application/pdf` whose bytes are a zip → 400 `CONTENT_MISMATCH` and nothing stored → Task 3 test "declared type that contradicts the bytes is refused before storing".
3. A link to another engagement's document gets the same 400 `EVIDENCE_NOT_FOUND` as a missing id, with no hint that it exists → Task 5 test "a link to another engagement's document is refused like a missing one".
4. A document that expired after it was linked does not block re-saving the record that cites it → Task 5 test "re-saving a record whose linked document has since expired is allowed".
5. A finding without `evidence` hashes exactly as on `main` → Task 5 test "a finding without evidence hashes as before 3A" (fixed hex value computed on `main`).

---

### Task 1: Sniffing and extractors (the spike, with fixtures)

**Files:**
- Create: `backend/src/evidence/sniff.ts`, `backend/src/evidence/extract/{index,pdf,docx,xlsx,text}.ts`
- Create: `backend/tests/fixtures/evidence/{sample.pdf,scanned.pdf,sample.docx,sample.xlsx,sample.csv,README.md}` (each ≤ 20 KB; README says how each was made)
- Modify: `backend/package.json` (dependencies `busboy`, `pdfjs-dist`, `mammoth`, `exceljs`; devDependency `@types/busboy`), `backend/Dockerfile:4,14` (`npm ci --omit=optional`, `npm ci --omit=dev --omit=optional`, with a comment: pdfjs-dist's optional canvas binding is not needed for text)
- Test: `backend/tests/evidence-extract.test.ts`

**Interfaces:**
- Produces: `type DocType = 'pdf' | 'docx' | 'xlsx' | 'text' | 'image' | 'zip' | 'binary'`; `sniff(bytes: Buffer, declaredMime: string, filename: string): { type: DocType; mime: string }` (canonical mime: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `…spreadsheetml.sheet`, `text/plain` | `text/csv` | `text/markdown` | `application/json`, `image/png` etc., `application/zip`, `application/octet-stream`); `class ContentMismatch extends Error` thrown when the declared mime names a different family than the bytes (`pdf` declared, zip found; `image/*` declared, text found; `text/*` or json declared, binary found); `zipUncompressedSize(bytes: Buffer): number` (sum of the central directory's uncompressed sizes; `Infinity` when the directory is unreadable);
- `interface Extracted { text: string; pageStarts: number[] | null; pages: number | null }`; `interface Extractor { name: string; version: string; extract(bytes: Buffer): Promise<Extracted> }`; `EXTRACTORS: Partial<Record<DocType, Extractor>>` for pdf, docx, xlsx, text; `class NoTextLayer extends Error` thrown by the pdf extractor when fewer than 20 non-whitespace characters came out.

- [ ] **Step 1: Make the fixtures and write the failing tests**

Make `sample.pdf` by hand (an uncompressed single-object PDF with two pages whose streams say `Batch record BMR-2026-0142 page one` and `Deviation DEV-0031 raised on page two`), `scanned.pdf` (one page, an image XObject or an empty stream, no text), `sample.docx` (a zip built with Python's `zipfile` holding `[Content_Types].xml`, `_rels/.rels`, `word/document.xml` with two paragraphs: `Training matrix` and `Operator A signed off on 2026-03-02`), `sample.xlsx` (written once with exceljs: sheet `Log` with header row `Batch | Result` and rows `0142 | pass`, `0143 | fail`), `sample.csv` (`batch,result\n0142,pass\n`). Tests:

```ts
it('sniffs by magic bytes and refuses a declared type the bytes contradict', () => {
  expect(sniff(pdf, 'application/pdf', 'a.pdf').type).toBe('pdf');
  expect(sniff(docx, 'application/octet-stream', 'a.docx').type).toBe('docx');
  expect(sniff(xlsx, 'application/octet-stream', 'a.xlsx').type).toBe('xlsx');
  expect(sniff(Buffer.from('batch,result\n'), 'text/csv', 'a.csv')).toEqual({ type: 'text', mime: 'text/csv' });
  expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'a.png').type).toBe('image');
  expect(() => sniff(docx, 'application/pdf', 'a.pdf')).toThrow(ContentMismatch);
  expect(sniff(Buffer.from([0, 1, 2, 3]), 'application/octet-stream', 'a.bin')).toEqual({ type: 'binary', mime: 'application/octet-stream' });
});
it('sums a zip central directory', () => expect(zipUncompressedSize(docx)).toBeGreaterThan(100));
it('extracts PDF text page by page', async () => {
  const r = await EXTRACTORS.pdf!.extract(pdf);
  expect(r.pages).toBe(2); expect(r.pageStarts).toEqual([0, expect.any(Number)]);
  expect(r.text).toContain('BMR-2026-0142'); expect(r.text.slice(r.pageStarts![1])).toContain('DEV-0031');
});
it('reports a PDF with no text layer', async () => { await expect(EXTRACTORS.pdf!.extract(scanned)).rejects.toBeInstanceOf(NoTextLayer); });
it('extracts docx paragraphs', async () => { expect((await EXTRACTORS.docx!.extract(docx)).text).toMatch(/Training matrix\n+Operator A signed off/); });
it('extracts xlsx as one page per sheet with tab-separated rows', async () => {
  const r = await EXTRACTORS.xlsx!.extract(xlsx);
  expect(r.pages).toBe(1); expect(r.text).toContain('# Log\nBatch\tResult\n0142\tpass\n0143\tfail');
});
it('passes text through', async () => { expect((await EXTRACTORS.text!.extract(Buffer.from('a,b\n'))).text).toBe('a,b\n'); });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run tests/evidence-extract.test.ts`
Expected: FAIL (modules not found)

- [ ] **Step 3: Install the four libraries and implement**

`npm install busboy pdfjs-dist@6 mammoth@1 exceljs@4 && npm install -D @types/busboy`. The pdf extractor loads `pdfjs-dist/legacy/build/pdf.mjs` with `await import(...)` once (cache the module promise), uses `getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false })`, and per page joins `getTextContent().items` text with spaces, `hasEOL` as `\n`; pages joined by `\n\n`; `pageStarts[i]` is the offset of page i's first char. The xlsx extractor uses `new ExcelJS.Workbook().xlsx.load(bytes)` and `cell.text`. Update the Dockerfile.

- [ ] **Step 4: Run the tests to verify they pass; prove the compiled build**

Run: `npx vitest run tests/evidence-extract.test.ts` → PASS. Then `npm run build && node -e "require('./dist/evidence/extract/index.js').EXTRACTORS.pdf.extract(require('fs').readFileSync('tests/fixtures/evidence/sample.pdf')).then(r=>console.log(r.pages))"` → prints `2` (the dynamic `import()` survives `tsc`). Record the output in your report. If it does not, stop and report BLOCKED with the error: the fallback decision is the controller's.

- [ ] **Step 5: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/Dockerfile backend/src/evidence backend/tests/evidence-extract.test.ts backend/tests/fixtures/evidence
git commit -m "feat(evidence): sniffing and text extractors for pdf, docx, xlsx and text"
```

---

### Task 2: Extraction log, runner and config; server extraction on registration

**Files:**
- Create: `backend/migrations/014_evidence.sql`, `backend/src/evidence/config.ts`, `backend/src/evidence/extraction-repo.ts`, `backend/src/evidence/extraction.ts`
- Modify: `backend/src/db/schema.ts` (add `DocumentExtractionsTable` and the `document_extractions` key), `backend/src/knowledge/document-repo.ts` (`DocumentRecord.extraction`, `getDocument`/`listDocuments` read the latest extraction row), `backend/src/knowledge/trail.ts` (add `recordExtractionEvent`), `backend/src/knowledge/routes.ts:109-130` (registration: client text → `client` row; no text → server extraction), `backend/src/ops/verify.ts` (no change in behaviour; add a comment that extraction rows are not integrity-checked, the text derives from the hashed bytes), `backend/tests/db-roles.test.ts:24-30` (`document_extractions: 'append'`), `backend/validation/requirements.json` (REQ-38), `backend/.env.example`
- Test: `backend/tests/evidence-extraction.test.ts`, `backend/tests/documents-http.test.ts` (existing registrations now carry `extraction`)

**Interfaces:**
- Consumes: Task 1's `sniff`, `EXTRACTORS`, `NoTextLayer`, `zipUncompressedSize`; existing `setDocumentText`, `chunkText`, `appendTrail`.
- Produces: `interface EvidenceConfig { extractMaxBytes: number; extractTimeoutMs: number; zipMaxUncompressedBytes: number; retentionYears: number | null }`, `loadEvidenceConfig(env?, storage?: { maxBytes: number }): EvidenceConfig` (env `EXTRACT_MAX_BYTES` default storage.maxBytes, `EXTRACT_TIMEOUT_MS` 30000, `ZIP_MAX_UNCOMPRESSED_BYTES` 268435456, `EVIDENCE_RETENTION_YEARS` unset → null, all zod-validated like `loadStorageConfig`); `type ExtractionStatus = 'ok' | 'no_text' | 'failed' | 'too_large' | 'unsupported' | 'client'`; `interface ExtractionRow { documentId; attempt; extractor; extractorVersion; status; chars; pages: number | null; error: string | null; at; by }`; `insertExtraction(db, row: Omit<ExtractionRow, 'attempt' | 'at'>): Promise<ExtractionRow>` (attempt = previous max + 1); `latestExtraction(db, documentId): Promise<ExtractionRow | null>`; `latestExtractions(db, documentIds: string[]): Promise<Map<string, ExtractionRow>>`; `DocumentRecord.extraction: { status: ExtractionStatus; extractor: string; version: string; chars: number; pages: number | null; error: string | null; at: string } | null`; `runExtraction(deps: { db: Executor; blobs: BlobStore; config: EvidenceConfig }, doc: DocumentRecord, actor: User, opts?: { bytes?: Buffer }): Promise<ExtractionRow>` — reads the bytes from `blobs.get(doc.sha256)` unless `opts.bytes` is given **and** its sha256 equals `doc.sha256` (test it), sniffs with the stored mime, applies the size/zip caps, runs the extractor under a `Promise.race` timeout, writes `document_text` + chunks on `ok` inside one transaction with the extraction row and the trail entry; `recordExtractionEvent(trx, actor, doc, row: ExtractionRow, chunks: number)` writes moduleId `document:extract`, inputs `{ documentId, sha256, extractor, version }`, output `{ status, chars, pages, chunks }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('records a client-text registration as status client [REQ-38]', …);   // POST /api/documents with text → extraction.status 'client', attempt 1
it('extracts a registered pdf from the stored bytes and chunks it [REQ-38]', …); // register sample.pdf without text → status ok, pages 2, chunks ≥ 2, searchable for "DEV-0031" with page 2, trail document:extract output.status ok
it('refuses to extract bytes whose hash is not the document's [REQ-38]', …);   // runExtraction(..., { bytes: other }) rejects; nothing written
it('marks a scanned pdf no_text and a zip unsupported, and keeps both searchable-less', …);
it('marks too_large above EXTRACT_MAX_BYTES and above the zip inflation cap', …); // config with small caps; docx with zipUncompressedSize > cap → too_large
it('marks failed on timeout with the error text and allows a second attempt', …); // EXTRACT_TIMEOUT_MS 1 and a slow extractor stub; attempt 2 ok
it('loads config defaults and refuses bad values', …);
```
Also update `documents-http.test.ts` expectations: a registration without text now returns `extraction.status` (`unsupported` for the fake `%PDF-` SOP bytes? No: those bytes start with `%PDF-`, so they sniff as pdf and extract as `no_text` or `failed` — assert `extraction.status` is one of those and that `chunks` is 0).

- [ ] **Step 2: Run to verify RED** — `npx vitest run tests/evidence-extraction.test.ts tests/documents-http.test.ts tests/db-roles.test.ts`

- [ ] **Step 3: Implement** the migration (table, UNIQUE, append-only triggers reusing `reject_change()`, `GRANT INSERT ON document_extractions TO audit_api`, `GRANT USAGE ON SEQUENCE document_extractions_id_seq TO audit_api`), the repo, the config, the runner, the trail recorder, the `DocumentRecord.extraction` join (one query with a lateral or a second query over ids; no N+1 in `listDocuments`), and the registration route change. Add REQ-38 to `requirements.json`: "Extracted text and chunks derive only from the stored bytes identified by sha256, with the extractor and its version recorded; every document has an extraction status." `evalKinds: []`.

- [ ] **Step 4: Run to verify GREEN**, then the whole suite: `npm test` and `npm run traceability`.

- [ ] **Step 5: Commit** — `git commit -m "feat(evidence): extraction log, runner and config; server extraction on registration"`

---

### Task 3: Upload, retry and text routes

**Files:**
- Create: `backend/src/evidence/routes.ts`
- Modify: `backend/src/errors.ts` (the seven codes), `backend/src/http/security.ts` (`RateLimits.uploadsPerMinute`, default 10, limiter `uploads`), `backend/src/app.ts` (mount `evidenceRoutes(svc, storage, { evidence: EvidenceConfig })`, OWN_BODY_PARSER gains the two upload paths, limiter on the two uploads and the retry; `OpsOptions.evidence?: EvidenceConfig`), `backend/src/server.ts` (`loadEvidenceConfig` into ops), `backend/src/knowledge/routes.ts` (export `storageCall`-style helpers or move them to `evidence/routes.ts`'s shared util)
- Test: `backend/tests/evidence-http.test.ts`

**Interfaces:**
- Consumes: Task 1 `sniff`/`ContentMismatch`; Task 2 `runExtraction`, `latestExtraction`, `EvidenceConfig`; existing `insertDocument`, `getDocument`, `recordDocumentEvent`, `mayRead`, `svc.engagement`.
- Produces: `EVIDENCE_UPLOAD_PATH = '/api/engagements/:id/evidence'`, `DOCUMENT_UPLOAD_PATH = '/api/documents/upload'`; `POST` both: multipart with one part `file` plus `kind`, `classification`, `retainUntil?`, `note?`; responses 201 `DocumentRecord & { chunks: number }`, 200 `DocumentRecord & { duplicate: true }`, 409 `DUPLICATE_DIFFERS` `{ existingId }`, 413, 400 `CONTENT_MISMATCH`; `POST /api/documents/:id/extract` → 200 `DocumentRecord`; `GET /api/documents/:id/text?page=` → `{ page: number | null; pages: number | null; text: string }`; `GET /api/documents` rows carry `extraction` (from Task 2).

- [ ] **Step 1: Write the failing tests** (supertest `.attach('file', buffer, { filename, contentType })` with `.field(...)`):

```ts
it('uploads evidence to an engagement, extracts it and lists it with its status [REQ-38]', …); // sample.pdf → 201, extraction ok, pages 2; GET /api/documents?engagementId lists it; search finds p.2
it('a part over the cap is 413 and nothing is stored or registered', …);        // maxUploadBytes 100, 200-byte file → 413 UPLOAD_TOO_LARGE; blob head null; documents count unchanged
it('declared type that contradicts the bytes is refused before storing', …);   // docx bytes, contentType application/pdf → 400 CONTENT_MISMATCH; blob head null
it('identical bytes on the same engagement return the existing document; a different classification is 409', …);
it('a duplicate the uploader may not read is invisible and a new row is made', …); // manager uploads restricted; auditor uploads same bytes internal → 201 new id
it('global upload needs a non-evidence kind and a preparer; viewers cannot upload', …);
it('retry runs a new attempt only after failed or too_large', …);                // 409 EXTRACTION_EXISTS when text exists; 409 UNSUPPORTED for a zip
it('text route serves one page or all, 404 without text, 410 when expired, same 404 when unreadable', …);
it('uploads are rate limited [REQ-38]', …);                                      // ops.rateLimits uploadsPerMinute 2 → third is 429
it('a note is stored in metadata and retainUntil defaults from EVIDENCE_RETENTION_YEARS', …);
```

- [ ] **Step 2: RED** — `npx vitest run tests/evidence-http.test.ts`

- [ ] **Step 3: Implement.** busboy with `limits: { files: 1, fileSize: storage.maxUploadBytes, fields: 8, fieldSize: 1024 }`; on `limit` event: destroy the stream, answer 413, store nothing. Collect the part into a Buffer, then `sniff` (400 on mismatch before any `put`), dedup query (`documents` by `sha256` and scope, filtered by `CLASSIFICATIONS_BY_ROLE[role]`), `put`, transaction: `insertDocument` (mime = sniffed), `blob_uploads`, `recordDocumentEvent`; then `runExtraction({ bytes })` (its own transaction). Dates: `retainUntil` defaults to today + `retentionYears` (UTC calendar date) when configured; a past date is 400.

- [ ] **Step 4: GREEN**, then `npm test`.

- [ ] **Step 5: Commit** — `git commit -m "feat(evidence): multipart upload, extraction retry and page text routes"`

---

### Task 4: Evidence tab, upload client and library documents

**Files:**
- Create: `frontend/src/evidence.ts` (pure helpers + API client), `frontend/src/evidence.test.ts`, `frontend/src/components/evidence/{EvidenceTab,UploadZone,DocumentList,TextDrawer}.tsx`
- Modify: `frontend/src/api.ts` (add `upload<T>(path, file: File, fields: Record<string, string>, onProgress?: (fraction: number) => void): Promise<T>` with `XMLHttpRequest`, the CSRF header, `credentials` same-origin, errors through `errorFrom`), `frontend/src/pages/EngagementPage.tsx:17-20,127-145` (STEPS gains `'Evidence'` at index 3; `FIELDWORK_TAB = 4`, `FINDINGS_TAB = 5`, `REPORT_TAB = 6`; every deep link that used the old numbers), `frontend/src/pages/LibraryPage.tsx` (a "Documents" section: global list + upload zone for preparers), `frontend/src/types.ts` (re-export `ExtractionStatus`, `ExtractionRow`, `EvidenceConfig` types as needed), `frontend/src/components/assistant/ResultCard.tsx` (`find_documents` rows show the status)
- Test: `frontend/src/evidence.test.ts`

**Interfaces:**
- Consumes: Task 3's routes and response shapes; `DocumentRecord.extraction`.
- Produces: `statusLabel(extraction): { label: string; color: 'default'|'success'|'warning'|'error'; retry: boolean }` (`ok` → `"Text (N pages)"`/`"Text"` success; `no_text` → "No text" warning; `failed` → "Failed" error, retry; `too_large` → "Too large" warning, retry; `unsupported` → "Stored" default; `client` → "Text" success; null → "Pending"); `formatSize(bytes)`; `uploadEvidence(engagementId, file, fields, onProgress)`, `uploadGlobal(...)`, `retryExtraction(id)`, `documentText(id, page?)`, `listDocuments(engagementId?)`, `searchEvidence(engagementId, q)`; `assistantEvents.notifyChanged(engagementId)` after an upload so an open assistant panel stays current.

- [ ] **Step 1: Write the failing tests** for `statusLabel`, `formatSize`, and that `requestInit`-equivalent headers for upload carry `x-csrf-token` (test the pure `uploadHeaders()` helper).
- [ ] **Step 2: RED** — `cd frontend && npx vitest run src/evidence.test.ts`
- [ ] **Step 3: Implement.** The tab: `UploadZone` (drag/drop + file input, kind select defaulting to `evidence`, classification select limited to the signed-in role's readable classifications, a note field, a progress bar; hidden for viewers), `DocumentList` (table: filename as a link to `/api/documents/:id/content`, kind, classification, size, uploader, date, status chip with a Retry button, a "Text" button opening `TextDrawer` with a page stepper; expired rows greyed with "expired"), a search box (debounced, `/api/knowledge/search?engagementId=&q=`) listing hits with page and plain-text snippet (reuse `plainSnippet` from `assistant.ts`). Tab constants and deep links shifted. Library: the same list and zone for global documents.
- [ ] **Step 4: GREEN**, `npm run typecheck && npm test && npm run build`.
- [ ] **Step 5: Commit** — `git commit -m "feat(evidence): Evidence tab, upload client, document list and library documents"`

---

### Task 5: Evidence links in the engine, service, gate, hash and report

**Files:**
- Create: `backend/src/evidence/links.ts`
- Modify: `backend/src/engine/types.ts:164-172,247-262` (`EvidenceLink`; `evidence?` on both), `backend/src/http/schemas.ts:23-28,30-43` (`EvidenceLinkSchema`; `evidence` on both schemas), `backend/src/service.ts:430-445,502-560,818-835` (`recordTest` and `applyFindingEdit` validate through `resolveEvidence` for new/changed links, normalise empty → absent; the CSV export prints links as `DOC-id p.N`), `backend/src/engine/qa.ts:47-72` (`hasEvidence`), `backend/src/engine/modules/gaps.ts:38` (copy `evidence` only when present), `backend/src/engine/modules/report.ts:58` (links rendered as `filename (p. N)` via a resolver passed in the module context; id when unresolvable), `backend/src/signing/content-hash.ts:7-10` (`...(f.evidence ? { evidence: f.evidence } : {})`), `backend/src/agents/qa/deterministic.ts:91` (either counts), `backend/src/knowledge/routes.ts` or `backend/src/evidence/routes.ts` (`GET /api/documents/:id/usage`), `backend/validation/requirements.json` (REQ-39)
- Test: `backend/tests/evidence-links.test.ts`; `backend/tests/content-hash.test.ts` (or the existing signing test file) for the fixed-hash assertion

**Interfaces:**
- Consumes: Task 2's `DocumentRecord.extraction.pages`; existing `getDocument`, `mayRead`.
- Produces: `interface EvidenceLink { documentId: string; page?: number; note?: string }`; `EvidenceLinkSchema`; `resolveEvidence(db, links: EvidenceLink[], scope: { engagementId: string; actor: User }): Promise<EvidenceLink[]>` (dedup by `(documentId, page)`; throws `AppError(400, …, 'EVIDENCE_NOT_FOUND' | 'EVIDENCE_EXPIRED')`); `changedLinks(previous: EvidenceLink[] | undefined, next: EvidenceLink[]): EvidenceLink[]`; `hasEvidence(input: Pick<TestInput, 'evidence' | 'evidenceRefs'>): boolean`; `normaliseEvidence(links?: EvidenceLink[]): EvidenceLink[] | undefined` (empty → undefined); `GET /api/documents/:id/usage` → `{ tests: { engagementId; rowId }[]; findings: { engagementId; findingId }[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('records a test with links to a readable document on the engagement and to a global one [REQ-39]', …);
it('a link to another engagement\'s document is refused like a missing one [REQ-39]', …);    // same status, code and message shape for both
it('a restricted document is refused for an auditor and accepted for an audit manager [REQ-39]', …);
it('an expired document cannot be newly linked, but re-saving a record whose linked document has since expired is allowed [REQ-39]', …);
it('a page beyond the extracted page count is refused; a page on a document without pages is accepted', …);
it('Effective with a link and no refs passes the evidence gate; with neither it is downgraded [REQ-05, REQ-39]', …);
it('the finding drafted from a linked test carries the links, prints them in the report and exports them', …);
it('a finding without evidence hashes as before 3A [REQ-39]', () => expect(findingContentHash(FIXED_FINDING)).toBe('<hex computed on main>'));
it('a finding with evidence hashes differently and an empty array is normalised to absent [REQ-39]', …);
it('usage lists the tests and findings that cite a document, within what the caller may list', …);
it('both golden agent traces are byte-identical', …);  // run the existing trace comparison; no fixture change
```
Compute the fixed hex on `main` before changing code (`git stash` or a scratch script) and paste it into the test.

- [ ] **Step 2: RED** — `npx vitest run tests/evidence-links.test.ts`
- [ ] **Step 3: Implement.** The report module needs filenames: pass a `documentNames: Map<string, { filename: string }>` in the module input (the service loads them for the finding's link ids before running `report`; the agent path does the same through the specialist wrapper). Add REQ-39: "An evidence link is accepted only for a document the actor may read, on that engagement or global, and not retention-expired; a conclusion of Effective needs at least one evidence link or reference; links are part of the finding's signed content."
- [ ] **Step 4: GREEN**, then `npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval && npm run traceability` (eval: both traces PASS unchanged).
- [ ] **Step 5: Commit** — `git commit -m "feat(evidence): evidence links on test records and findings, gate, hash, report and usage"`

---

### Task 6: Evidence picker in the fieldwork card, finding dialog and cards

**Files:**
- Create: `frontend/src/components/evidence/EvidencePicker.tsx`
- Modify: `frontend/src/components/engagement/FieldworkTab.tsx:10-19,78-82,93-103` (`Draft.evidence: EvidenceLink[]`; the picker above the renamed "Other references" field; the PUT body sends `evidence`), `frontend/src/components/engagement/FindingEditDialog.tsx:14-20,60-75` (the picker; the body sends `evidence`), `frontend/src/components/engagement/FindingsTab.tsx:154` (links as chips `filename p.N` before the free-text refs), the signing card component that shows a finding's content (find it: it lists `evidenceRefs`; add the links), `frontend/src/evidence.ts` (`linkLabel(link, documents)`), `frontend/src/types.ts` (`EvidenceLink`)
- Test: `frontend/src/evidence.test.ts` (`linkLabel`, `toggleLink`)

**Interfaces:**
- Consumes: Task 4's `listDocuments`; Task 5's `EvidenceLink` and the `evidence` fields.
- Produces: `EvidencePicker({ engagementId, value: EvidenceLink[], onChange, disabled })` — an autocomplete over the engagement's and the global documents the person may read (hidden: expired, `unsupported`? no: any document can be cited, a stored scan too), each pick with an optional page number input bounded by `extraction.pages` when known, chips with a remove button; `toggleLink(links, link)`; `linkLabel(link, documents): string` (`"BMR-2026-0142.pdf p.7"`, or the id when the document is not in the list).

- [ ] **Step 1: Write the failing tests** for `linkLabel` and `toggleLink` (dedup by documentId+page).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN**, `npm run typecheck && npm test && npm run build`.
- [ ] **Step 5: Commit** — `git commit -m "feat(evidence): document picker on test records and findings; links on cards"`

---

### Task 7: Retention job, docs and requirements

**Files:**
- Create: `backend/src/evidence/retention.ts`
- Modify: `backend/src/db/cli.ts` (command `retention`), `backend/package.json` (`"retention": "tsx src/db/cli.ts retention"`), `backend/validation/requirements.json` (REQ-40), `backend/.env.example`, `README.md` (new `## Evidence` section after `## Assistant`: upload, what is extracted, statuses, links on tests and findings, retention; one line in `## Checks`), `docs/deploy/operations.md` (`## 9. Evidence`: the retention job and its "retained by record" output, limits and nginx `client_max_body_size`, statuses and retry, the honest statement that the timeout bounds latency and the zip cap bounds inflation, the Dockerfile's `--omit=optional`), `docs/superpowers/specs/2026-10-22-evidence-management-design.md` §12 (`**Made during the build (3A):**` bullets from the ledger's rulings)
- Test: `backend/tests/evidence-retention.test.ts`

**Interfaces:**
- Consumes: Task 5's usage scan (factor it into `linkedDocumentIds(db): Promise<Set<string>>` in `links.ts` if not already a function).
- Produces: `runRetention(db: Kysely<DB>, today: string): Promise<{ expired: string[]; retainedByRecord: string[] }>` (owner role; sets `retention_expired = true` where `retain_until < today` and not already expired and not linked; idempotent); CLI prints the counts and the skipped ids, exit 0.

- [ ] **Step 1: Write the failing tests**

```ts
it('expires documents past their date and leaves linked ones, listing them [REQ-40]', …);
it('an expired document answers 410 on content and text, is absent from search, is still listed, and verify passes [REQ-40, REQ-24]', …);
it('is idempotent', …);
```
- [ ] **Step 2: RED.** **Step 3: Implement**, write the docs, add REQ-40: "The retention job hides expired content and search results and leaves the record, the trail and verify intact; documents linked from a test or finding are never expired by the job."
- [ ] **Step 4: Verify everything:** `cd backend && npm run typecheck && npm test && ALLOW_UNVERIFIED_CITATIONS=true npm run eval && npm run traceability; cd ../frontend && npm run typecheck && npm test && npm run build` — all green, traceability fully covered, both traces unchanged.
- [ ] **Step 5: Commit** — `git commit -m "feat(evidence): retention job; evidence docs, runbook and REQ-40"`
