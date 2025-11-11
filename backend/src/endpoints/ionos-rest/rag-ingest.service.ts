// 
// Copyright (c) 2025 Industry Fusion Foundation
// 
// Licensed under the Apache License, Version 2.0 (the "License"); 
// you may not use this file except in compliance with the License. 
// You may obtain a copy of the License at 
// 
//   http://www.apache.org/licenses/LICENSE-2.0 
// 
// Unless required by applicable law or agreed to in writing, software 
// distributed under the License is distributed on an "AS IS" BASIS, 
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. 
// See the License for the specific language governing permissions and 
// limitations under the License. 
// 

// src/rag-ingest.service.ts (refactor)
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import pdfParse from 'pdf-parse';
import { MilvusRagService } from './milvus.service';
import { IonosService } from './ionos.service';

/**
 * CHANGES:
 * - Token-based chunking (defaults 200–400 tokens with 50–100 overlap via env)
 * - Section-aware PDF splitting (headings/paragraphs) + table-preserving heuristic
 * - Hybrid-ready metadata: machine_id, asset_name, dt_version, ts_start, ts_end, section_path, page_no
 * - Hierarchy: create a parent (doc-level) embedding + child chunks
 * - Stable dedupe via sha256(content) and per-PDF file hash
 */

type ChildChunk = { idx: number; content: string; hash: string; sectionPath?: string; pageNo?: number };

type VectorDoc = {
  name: string;
  contentType: string;
  vector: number[];
  labels: Record<string, any>;
};

@Injectable()
export class RagIngestService implements OnModuleInit {
  private readonly log = new Logger(RagIngestService.name);

  private readonly collectionName = process.env.RAG_COLLECTION_NAME ?? 'factory-jsonld';
  private readonly ingestDir = process.env.RAG_INGEST_DIR ?? './data/jsonld';
  private readonly embedDim = +(process.env.RAG_EMBED_DIM ?? '1024');
  private readonly embedMetric: 'COSINE' | 'L2' | 'IP' = (process.env.RAG_EMBED_METRIC as any) ?? 'COSINE';

  // === token chunking defaults (recommended):
  private readonly tokenChunkMin = +(process.env.RAG_TOKEN_CHUNK_MIN ?? '200');
  private readonly tokenChunkMax = +(process.env.RAG_TOKEN_CHUNK_MAX ?? '400');
  private readonly tokenOverlap = +(process.env.RAG_TOKEN_CHUNK_OVERLAP ?? '80');

  // For backwards-compat PDF concurrency
  private readonly pdfConcurrency = +(process.env.RAG_PDF_CONCURRENCY ?? '1');

  // dedupe across JSON-LD chunks and PDF chunks
  private seenHashes = new Set<string>();
  private seenPdfFileHashes = new Set<string>();

  constructor(
    private readonly http: HttpService,
    private readonly milvus: MilvusRagService,
    private readonly ionos: IonosService,
  ) {}

  async onModuleInit() {
    await this.milvus.getOrCreateCollectionName(this.collectionName, this.embedDim, this.embedMetric);
    this.log.log(`Collection ready: ${this.collectionName} (dim=${this.embedDim}, metric=${this.embedMetric})`);
    //this.ingestFolder(); // opt-in
  }

  /** Entry – scans folder, builds vectors, uploads. */
  async ingestFolder(folder = this.ingestDir) {
    this.log.log(`cwd=${process.cwd()}`);
    this.log.log(`ingestDir=${folder} (abs: ${path.resolve(folder)})`);

    // 1) list candidate files
    const targets = await this.listJsonFiles(folder);
    this.log.log(`Found ${targets.length} JSON/JSON-LD files`);

    const childDocs: Promise<VectorDoc>[] = [];
    const parentDocs: Promise<VectorDoc>[] = [];
    const pdfUrls = new Set<string>();

    // 2) JSON-LD → sectioned text → token chunks → vectors
    for (const file of targets) {
      const full = path.join(folder, file);
      let json: any;
      try {
        const raw = await fs.readFile(full, 'utf8');
        json = JSON.parse(raw);
      } catch (e: any) {
        this.log.warn(`Skip (parse error) ${file}: ${e?.message || e}`);
        continue;
      }

      this.collectPdfUrls(json, pdfUrls);

      const entities = Array.isArray(json) ? json : [json];
      for (let eidx = 0; eidx < entities.length; eidx++) {
        const ent = entities[eidx];
        const baseName = `${path.basename(file)}${entities.length > 1 ? `@${eidx}` : ''}`;

        // Flatten and convert JSON-LD entity to "facts" paragraphs
        const flat = this.flattenJsonLd(ent);
        const { machineMeta, factParagraphs } = this.jsonLdToParagraphsWithMeta(flat);

        if (!factParagraphs.length) continue;

        // Create a parent doc (summary/route embedding)
        const parentId = this.sha256(`${baseName}:parent`);
        parentDocs.push(this.embedChunk(`${baseName}#parent`, factParagraphs.join('\n'), {
          kind: 'parent',
          source: file,
          entityId: flat.id ?? '',
          entityType: flat.type ?? '',
          parent_id: parentId,
          ...machineMeta,
        }));

        // Token-based chunking with overlap
        const chunks = this.chunkByTokens(factParagraphs.join('\n'), this.tokenChunkMin, this.tokenChunkMax, this.tokenOverlap);
        chunks.forEach((ch, idx) => {
          const hash = this.sha256(ch);
          if (this.seenHashes.has(hash)) return;
          this.seenHashes.add(hash);

          const labels: Record<string, any> = {
            sha256: hash,
            source: file,
            kind: 'jsonld',
            chunk: String(idx),
            parent_id: parentId,
            text: ch,
            entityId: flat.id ?? '',
            entityType: flat.type ?? '',
            ...machineMeta,
          };
          childDocs.push(this.embedChunk(`${baseName}#${idx}`, ch, labels));
        });
      }
    }

    const jsonParents = await Promise.all(parentDocs);
    const jsonChildren = await Promise.all(childDocs);
    this.log.log(`Prepared JSON-LD parents: ${jsonParents.length}, children: ${jsonChildren.length}`);

    // 3) PDFs → download → parse → section-aware paragraphization → token chunks → vectors
    const pdfDocs = await this.processPdfs(Array.from(pdfUrls));

    const allDocs = [...jsonParents, ...jsonChildren, ...pdfDocs].filter(d => {
      if (!Array.isArray(d.vector) || d.vector.length !== this.embedDim) {
        this.log.warn(`Drop doc "${d.name}" due to dim mismatch ${d.vector?.length} != ${this.embedDim}`);
        return false;
      }
      return true;
    });

    this.log.log(`Uploading ${allDocs.length} docs to ${this.collectionName}…`);
    if (allDocs.length) {
      await this.milvus.addDocuments(
        this.collectionName,
        allDocs.map(d => ({ name: d.name, contentType: d.contentType, labels: d.labels, vector: d.vector }))
      );
    }
    this.log.log('Ingestion complete.');
  }

  // ---------- Embedding ----------
  private async embedChunk(name: string, content: string, labels: Record<string, any>): Promise<VectorDoc> {
    const resp = await this.ionos.createEmbeddings({ input: content });
    const vec = resp.data[0].embedding;
    return { name, contentType: 'text/plain', vector: vec, labels };
  }

  // ---------- PDFs ----------
  private async processPdfs(urls: string[]): Promise<VectorDoc[]> {
    if (!urls.length) return [];
    this.log.log(`Found ${urls.length} PDF urls`);

    const out: VectorDoc[] = [];
    const pool: Promise<void>[] = [];

    const worker = async (url: string) => {
      try {
        const resp = await firstValueFrom(this.http.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          headers: { Accept: 'application/pdf' },
          validateStatus: s => s >= 200 && s < 400,
        }));
        const buf = Buffer.from(resp.data as any);
        const pdfFileHash = this.sha256(buf);
        if (this.seenPdfFileHashes.has(pdfFileHash)) {
          this.log.debug(`Skip PDF (already seen): ${url}`);
          return;
        }
        this.seenPdfFileHashes.add(pdfFileHash);

        const parsed = await pdfParse(buf);
        const fullText = (parsed?.text || '').replace(/\r/g, '').trim();
        if (!fullText) {
          this.log.warn(`PDF has no extractable text (maybe scanned): ${url}`);
          return;
        }

        const fileName = url.split('/').pop() || 'manual.pdf';
        const parentId = this.sha256(`${fileName}:parent:${pdfFileHash}`);

        // Parent doc (whole-doc routing embedding, truncated if huge)
        const parentText = fullText.length > 12000 ? fullText.slice(0, 12000) : fullText;
        out.push(await this.embedChunk(`${fileName}#parent`, parentText, {
          kind: 'parent',
          parent_id: parentId,
          pdfFileHash,
          sourceUrl: url,
          filename: fileName,
          pageCount: String(parsed?.numpages ?? ''),
        }));

        // Section-aware paragraphization
        const paragraphs = this.sectionizePdfText(fullText);
        const joined = paragraphs.map(p => p.text).join('\n');
        const chunks = this.chunkByTokens(joined, this.tokenChunkMin, this.tokenChunkMax, this.tokenOverlap);

        let idx = 0;
        for (const ch of chunks) {
          const combinedHash = this.sha256(pdfFileHash + ':' + ch);
          if (this.seenHashes.has(combinedHash)) continue;
          this.seenHashes.add(combinedHash);

          // best-effort section path (first heading seen within the segment)
          const sectionPath = this.pickSectionForSpan(paragraphs, ch);

          out.push(await this.embedChunk(`${fileName}#${idx}`, ch, {
            sha256: combinedHash,
            pdfFileHash,
            sourceUrl: url,
            filename: fileName,
            pageCount: String(parsed?.numpages ?? ''),
            kind: 'pdf-text',
            chunk: String(idx),
            parent_id: parentId,
            text: ch,
            section_path: sectionPath,
          }));
          idx++;
        }
      } catch (e: any) {
        this.log.warn(`Failed PDF ingest: ${url} -> ${e?.message || e}`);
      }
    };

    for (const url of urls) {
      const p = worker(url).finally(() => {
        const i = pool.indexOf(p as any);
        if (i >= 0) pool.splice(i, 1);
      }) as Promise<void>;
      pool.push(p);
      if (pool.length >= this.pdfConcurrency) await Promise.race(pool);
    }
    await Promise.all(pool);
    return out;
  }

  // ---------- JSON-LD helpers ----------
  private collectPdfUrls(obj: any, set: Set<string>) {
    const walk = (v: any) => {
      if (v == null) return;
      if (typeof v === 'string') {
        if (/\.pdf(\?|#|$)/i.test(v)) set.add(v);
        return;
      }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (typeof v === 'object') {
        if (v.type === 'Property' && v.value != null) walk(v.value);
        Object.keys(v).forEach(k => { if (k !== 'value') walk(v[k]); });
      }
    };
    walk(obj);
  }

  private jsonLdToParagraphsWithMeta(flat: any): { machineMeta: Record<string, any>; factParagraphs: string[] } {
    const machineMeta: Record<string, any> = {};

    // heuristics for common keys
    const pick = (keys: string[]) => keys.find(k => flat[k] != null);
    const midKey = pick(['machine_id', 'machineId', 'asset_id', 'assetId', 'id']);
    const nameKey = pick(['product_name', 'asset_name' , 'name', 'assetName']);
    const verKey = pick(['dt_version', 'schema_version', 'version']);
    const tsStartKey = pick(['ts_start', 'timestamp_start', 'validFrom', 'from']);
    const tsEndKey = pick(['ts_end', 'timestamp_end', 'validTo', 'to']);

    if (midKey) machineMeta.machine_id = String(flat[midKey]);
    if (nameKey) machineMeta.asset_name = String(flat[nameKey]);
    if (verKey) machineMeta.dt_version = String(flat[verKey]);
    if (tsStartKey) machineMeta.ts_start = this.tryToEpoch(flat[tsStartKey]);
    if (tsEndKey) machineMeta.ts_end = this.tryToEpoch(flat[tsEndKey]);

    // turn flat object into labeled lines (facts)
    const lines: string[] = [];
    const add = (k: string, v: any) => lines.push(`${k}: ${String(v)}`);

    if (flat.id) add('id', flat.id);
    if (flat.type) add('type', flat.type);

    const walk = (obj: any, prefix = '') => {
      if (obj == null) return;
      if (Array.isArray(obj)) {
        add(prefix || 'list', obj.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' | '));
        return;
      }
      if (typeof obj !== 'object') { if (prefix) add(prefix, obj); return; }
      for (const k of Object.keys(obj)) {
        if (k === 'id' || k === 'type') continue;
        const v = obj[k];
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const primitivesOnly = Object.values(v).every(x => x == null || ['string','number','boolean'].includes(typeof x));
          if (primitivesOnly) {
            add(key, Object.entries(v).map(([ik, iv]) => `${ik}=${iv}`).join(','));
          } else {
            walk(v, key);
          }
        } else if (Array.isArray(v)) {
          add(key, v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('|'));
        } else {
          add(key, v);
        }
      }
    };
    walk(flat);

    // group into paragraphs by top-level prefixes to form nicer section boundaries
    const paragraphs = this.groupLinesIntoParagraphs(lines);
    return { machineMeta, factParagraphs: paragraphs };
  }

  private flattenJsonLd(input: any): any {
    const out: any = {};
    if (input == null || typeof input !== 'object') return input;
    if (input.id || input['@id']) out.id = input.id ?? input['@id'];
    if (input.type || input['@type']) out.type = input.type ?? input['@type'];

    const reserved = new Set(['id', '@id', 'type', '@type']);
    for (const key of Object.keys(input)) {
      if (reserved.has(key)) continue;
      const v = input[key];

      if (v && typeof v === 'object' && v.type === 'Property') {
        out[key] = this.pickVal(v.value);
        if (v.unit?.type === 'Property') out[`${key}__unit`] = this.pickVal(v.unit.value);
        if (v.segment?.type === 'Property') out[`${key}__segment`] = this.pickVal(v.segment.value);
        if (v.owner_ref?.type === 'Property') out[`${key}__owner`] = this.pickVal(v.owner_ref.value);
        if (v.model?.type === 'Property') out[`${key}__modeled`] = this.pickVal(v.model.value);
        if (v.translation?.type === 'Property') out[`${key}__translation`] = this.pickVal(v.translation.value);
      } else if (Array.isArray(v)) {
        out[key] = v.map(x => this.flattenJsonLd(x));
      } else if (typeof v === 'object' && v !== null) {
        out[key] = this.flattenJsonLd(v);
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  private pickVal(val: any): any {
    if (val === 'NULL') return null;
    if (val && typeof val === 'object' && 'value' in val && 'language' in val) return val.value;
    return val;
  }

  // ---------- chunking & utils ----------
  private chunkByTokens(text: string, minTokens: number, maxTokens: number, overlap: number): string[] {
    // Rough token estimate: word-ish units. Replace with tiktoken if available.
    const words = text.split(/\s+/).filter(Boolean);
    const chunks: string[] = [];
    if (!words.length) return chunks;

    // Build adaptive windows between min and max tokens, but respect paragraph boundaries when possible
    let start = 0;
    let idx = 0;
    while (start < words.length) {
      const target = Math.min(words.length, start + maxTokens);
      let end = target;

      // try to backtrack to nearest paragraph break ("\n\n") within window
      const windowText = words.slice(start, target).join(' ');
      const localBreak = windowText.lastIndexOf('\n\n');
      if (localBreak > -1) {
        const upto = windowText.slice(0, localBreak);
        const uptoCount = upto.split(/\s+/).filter(Boolean).length;
        if (uptoCount >= minTokens) end = start + uptoCount;
      }

      const piece = words.slice(start, end).join(' ').trim();
      if (piece) chunks.push(piece);
      if (end >= words.length) break;

      // overlap
      start = Math.max(0, end - overlap);
      idx++;
    }
    return chunks;
  }

  private groupLinesIntoParagraphs(lines: string[]): string[] {
    const paras: string[] = [];
    let buf: string[] = [];

    const flush = () => { if (buf.length) { paras.push(buf.join('\n')); buf = []; } };

    for (const line of lines) {
      // New paragraph when line looks like a heading / section key
      if (/^(\d+\.|[A-Z][A-Za-z0-9_\- ]{2,}|[A-Z_]{3,})\s*:/.test(line)) {
        flush();
        buf.push(line);
        flush();
        continue;
      }
      buf.push(line);
    }
    flush();
    return paras.filter(Boolean);
  }

  private sectionizePdfText(fullText: string): { text: string; heading?: string }[] {
    const lines = fullText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const sections: { text: string; heading?: string }[] = [];

    let current: { text: string; heading?: string } | null = null;
    const isHeading = (s: string) => (/^(\d+(?:\.\d+)*\.?\s+)?[A-Z][A-Za-z0-9 \-]{2,}$/.test(s) && s.length < 120) || /^[A-Z0-9 \-]{6,}$/.test(s);
    const looksLikeTableRow = (s: string) => /\s{2,}\S+\s{2,}/.test(s) && /\|/.test(s) === false; // crude heuristic

    for (const ln of lines) {
      if (isHeading(ln)) {
        if (current) sections.push(current);
        current = { text: ln + '\n', heading: ln };
        continue;
      }
      if (!current) current = { text: '' };

      // keep table-like blocks together by replacing single newlines with \n until a blank line is encountered
      if (looksLikeTableRow(ln)) {
        current.text += ln + '\n';
      } else {
        current.text += ln + '\n';
      }
    }
    if (current) sections.push(current);

    // Merge tiny sections into neighbors
    const merged: { text: string; heading?: string }[] = [];
    for (const sec of sections) {
      const tokenCount = sec.text.split(/\s+/).filter(Boolean).length;
      if (merged.length && tokenCount < 80) {
        merged[merged.length - 1].text += '\n' + sec.text;
      } else {
        merged.push(sec);
      }
    }
    return merged;
  }

  private pickSectionForSpan(paragraphs: { text: string; heading?: string }[], span: string): string {
    // choose first heading that appears within span text
    for (const p of paragraphs) {
      if (p.heading && span.includes(p.heading)) return p.heading;
    }
    return '';
  }

  private tryToEpoch(v: any): number | null {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? Math.floor(t) : null;
  }

  private async listJsonFiles(root: string): Promise<string[]> {
    const exists = fssync.existsSync(root);
    if (!exists) return [];
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries.map(e => e.isDirectory() ? walk(path.resolve(dir, e.name)) : Promise.resolve([path.resolve(dir, e.name)])),
      );
      return files.flat().filter(f => f.endsWith('.json') || f.endsWith('.jsonld')).map(f => path.relative(root, f));
    };
    return walk(root);
  }

  private sha256(bufOrStr: Buffer | string): string {
    const h = crypto.createHash('sha256');
    h.update(bufOrStr);
    return h.digest('hex');
  }
}
