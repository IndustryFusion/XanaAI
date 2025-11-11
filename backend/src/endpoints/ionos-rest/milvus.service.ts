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

// milvus-rag.service.ts
import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

type DocInput = {
    name: string;
    contentType?: string;     // e.g. 'text/plain', 'image/png'
    url?: string;             // where the raw file/text lives (S3, MinIO, etc.)
    labels?: Record<string, any>; // arbitrary metadata; stored in JSON field
    vector: number[];         // embedding to store in Milvus
};

@Injectable()
export class MilvusRagService {
    private readonly base = (process.env.MILVUS_API_URL ?? 'http://localhost:19530').replace(/\/+$/, '');
    private readonly dbName = process.env.MILVUS_DB ?? 'default';
    private readonly token = process.env.MILVUS_TOKEN ?? 'root:Milvus'; // Bearer "user:pass"
    private readonly headers = {
        'Content-Type': 'application/json'
    };

    constructor(private readonly http: HttpService) { }

    // -------- Collections --------
    async listCollections(): Promise<string[]> {
        const url = `${this.base}/v2/vectordb/collections/list`;
        const body = { dbName: this.dbName };
        const r = await firstValueFrom(this.http.post(url, body, { headers: this.headers }));
        // returns { code, data: string[] }
        return r.data?.data ?? [];
    }

    async hasCollection(name: string): Promise<boolean> {
        const url = `${this.base}/v2/vectordb/collections/has`;
        const body = { dbName: this.dbName, collectionName: name };
        const r = await firstValueFrom(this.http.post(url, body, { headers: this.headers }));
        return Boolean(r.data?.data);
    }

    /**
     * Create (if needed) a collection suitable for RAG:
     * - id: INT64 primary (autoID)
     * - vector: FLOAT_VECTOR (dim)
     * - name/url/contentType: VARCHAR
     * - labels: JSON
     * - HNSW index on vector
     */
    async getOrCreateCollectionName(
        name: string,
        dim: number,
        metricType: 'COSINE' | 'L2' | 'IP' = 'COSINE',
    ): Promise<string> {
        if (await this.hasCollection(name)['has']) return name;

        const url = `${this.base}/v2/vectordb/collections/create`;
        const body = {
            dbName: this.dbName,
            collectionName: name,
            schema: {
                autoID: true,
                enableDynamicField: false,
                fields: [
                    { fieldName: 'id', dataType: 'DataType.INT64', isPrimary: true },
                    { fieldName: 'vector', dataType: 'DataType.FLOAT_VECTOR', dim, nullable: false },
                    { fieldName: 'name', dataType: 'DataType.VARCHAR', max_length: 1024, nullable: true },
                    { fieldName: 'contentType', dataType: 'DataType.VARCHAR', max_length: 128, nullable: true },
                    { fieldName: 'url', dataType: 'DataType.VARCHAR', max_length: 2048, nullable: true },
                    { fieldName: 'labels', dataType: 'DataType.JSON', nullable: true },
                ],
            },
            indexParams: [
                {
                    fieldName: 'vector',
                    metricType,
                    indexName: 'vector',
                    params: { index_type: 'HNSW', M: 16, efConstruction: 200 },
                },
            ],
            params: { consistencyLevel: 'Bounded' },
        };

        await firstValueFrom(this.http.post(url, body, { headers: this.headers }));

        // Load the collection into memory for searching
        await this.loadCollection(name);

        return name;
    }

    async loadCollection(name: string) {
        const url = `${this.base}/v2/vectordb/collections/load`;
        const body = { dbName: this.dbName, collectionName: name };
        await firstValueFrom(this.http.post(url, body, { headers: this.headers }));
    }

    // -------- “Documents” (entities) --------
    /**
     * Insert docs (each needs a vector). Store raw file/text in object storage; keep the URL and metadata here.
     */
    async addDocuments(collectionName: string, docs: DocInput[]) {
        const url = `${this.base}/v2/vectordb/entities/insert`;
        const data = docs.map(d => ({
            vector: d.vector,
            name: d.name,
            contentType: d.contentType ?? null,
            url: d.url ?? null,
            labels: JSON.stringify(d.labels)
        }))
        const body = { dbName: this.dbName, collectionName, data };
        const r = await firstValueFrom(this.http.post(url, body, { headers: this.headers }));
        return r.data; // { code, data: { insertCount, insertIds } }
    }

    /**
     * List a few rows (metadata) from the collection.
     */
    async listDocuments(collectionName: string, limit = 100): Promise<any[]> {
        const url = `${this.base}/v2/vectordb/entities/query`;
        const body = {
            dbName: this.dbName,
            collectionName,
            filter: 'id >= 0',
            outputFields: ['name', 'contentType', 'url', 'labels'],
            limit,
        };
        const r = await firstValueFrom(this.http.post(url, body, { headers: this.headers }));
        return r.data?.data ?? [];
    }

    /**
     * Vector similarity search with optional metadata filter.
     */
    async search(
        collectionName: string,
        queryVector: number[],
        limit = 5,
        filter?: string,
        outputFields: string[] = ['name', 'contentType', 'url', 'labels'],
    ) {
        const url = `${this.base}/v2/vectordb/entities/search`;
        const body = {
            dbName: this.dbName,
            collectionName,
            data: [queryVector],
            annsField: 'vector',
            limit,
            outputFields,
            ...(filter ? { filter } : {}),
            searchParams: { metricType: 'COSINE', params: { ef: 128 } },
        };
        const r = await firstValueFrom(this.http.post(url, body, { headers: this.headers }));
        return r.data?.data ?? [];
    }
}
