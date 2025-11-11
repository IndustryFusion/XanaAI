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

import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | 'function';
export interface ChatMessage {
    role: ChatRole;
    content: string;
}

@Injectable()
export class IonosService {
    private readonly apiKey = process.env.COMPLETIONS_API_KEY;
    private readonly baseUrl = process.env.COMPLETIONS_API_URL;

    constructor(private readonly http: HttpService) { }


    async chatCompletion(params: {
        messages: ChatMessage[];
        temperature?: number;
        maxTokens?: number;
        extra?: Record<string, any>;         // for top_p, presence_penalty, tools, etc.
    }) {
        const url = `${this.baseUrl}/v1/chat/completions`;
        const body = {
            model: "meta-llama/Llama-3.3-70B-Instruct",
            messages: params.messages,
            temperature: params.temperature ?? 0.3,
            max_tokens: params.maxTokens ?? 1024,
            ...(params.extra ?? {}),
        };

        const resp = await firstValueFrom(
            this.http.post(url, body, {
                headers: {

                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
            }),
        );
        return resp.data; // standard OpenAI-compatible response
    }

    /** (2) Embeddings */
    async createEmbeddings(params: {                 // e.g. "bge-m3" or your IONOS embedding model
        input: string | string[];        // text or batch
        encodingFormat?: 'float' | 'base64';
    }) {
        const url = `${this.baseUrl}/v1/embeddings`;
        const body = {
            model: "BAAI/bge-m3",
            input: params.input
        };

        const resp = await firstValueFrom(
            this.http.post(url, body, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
            })
        );
        const targetDim = parseInt(process.env.RAG_EMBED_DIM ?? '1024', 10);

        // fit each returned vector to targetDim (truncate or zero-pad)
        const fit = (v: number[]): number[] => {
            if (v.length === targetDim) return v;
            if (v.length > targetDim) return v.slice(0, targetDim);
            const out = new Array(targetDim).fill(0);
            for (let i = 0; i < v.length; i++) out[i] = v[i];
            return out;
        };

        const data = (resp.data?.data ?? []).map((d: any) => ({
            ...d,
            embedding: fit(d.embedding),
        }));

        // Optional one-time log
        if (!(global as any).__logged_bge_dim) {
            (global as any).__logged_bge_dim = true;
            const got = resp.data?.data?.[0]?.embedding?.length;
            console.log(`[embeddings] server dim=${got}, fitted to ${targetDim}`);
        }

        return { ...resp.data, data };
    }

}
