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

// // ionos-rag.service.ts
// import { Injectable } from '@nestjs/common';
// import { HttpService } from '@nestjs/axios';
// import { firstValueFrom } from 'rxjs';

// @Injectable()
// export class IonosRagService {
//   private readonly base = process.env.COLLECTION_API_URL!;
//   private readonly headers = {
//     Authorization: `Bearer ${process.env.COMPLETIONS_API_KEY_IONOS}`,
//     'Content-Type': 'application/json',
//   };

//   constructor(private readonly http: HttpService) {}

//   // --- Collections ---
//   async listCollections(): Promise<any[]> {
//     const url = `${this.base}/collections?limit=1`;
//     const r = await firstValueFrom(this.http.get(url, { headers: this.headers, timeout: 800000 }));
//     console.log('Collection list:', r.data);
//     return r.data?.items ?? r.data ?? []; // tolerate shapes
//   }

//   async getOrCreateCollectionId(name: string, description?: string): Promise<string> {
//     const all = await this.listCollections();
//     const found = all.find((c: any) =>
//       c?.properties?.name === name || c?.name === name || c?.properties?.id === name || c?.id === name);
//     if (found?.id) return found.id;

//     const url = `${this.base}/collections`;
//     const body = { properties: { name, description: description ?? name } };
//     const r = await firstValueFrom(this.http.post(url, body, { headers: this.headers, timeout: 800000 }));
//     // Some APIs return object, some return list—handle both
//     console.log('Created collection:', r.data);
//     const created = r.data?.id ? r.data : (r.data?.items?.[0] ?? r.data);
//     return created.id;
//   }

//   // --- Documents ---
//   async listDocuments(collectionId: string, limit = 1000): Promise<any[]> {
//     const url = `${this.base}/collections/${collectionId}/documents?limit=${limit}`;
//     const r = await firstValueFrom(this.http.get(url, { headers: this.headers, timeout: 800000 }));
//     console.log('Document list:', r.data);
//     return r.data?.items ?? r.data ?? [];
//   }

//   async addDocuments(collectionId: string, docs: Array<{
//     name: string;
//     contentType: string;    // e.g. 'text/plain'
//     contentBase64: string;
//     labels?: Record<string, string>;
//   }>) {
//     const url = `${this.base}/collections/${collectionId}/documents`;
//     // Many APIs accept PUT/POST with an array of {properties:{...}}
//     const payload = docs.map(d => ({
//       properties: {
//         name: d.name,
//         contentType: d.contentType,
//         content: d.contentBase64,
//         labels: d.labels ?? {},
//       },
//     }));

//     console.log('Adding documents:', payload);
//     // Try PUT first; if your tenant expects POST, just change it to POST:
//     const r = await firstValueFrom(this.http.put(url, payload, { headers: this.headers, timeout: 800000 }));
//     return r.data;
//   }
// }
