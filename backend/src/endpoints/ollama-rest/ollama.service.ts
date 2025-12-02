//*****************************************************************************
// Copyright 2025 Intel Corporation
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//*****************************************************************************

import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | 'function';
export interface ChatMessage {
    role: ChatRole;
    content: string;
}

@Injectable()
export class OllamaService {
    private readonly baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    
    // Server endpoints configuration
    //private readonly baseUrl: string = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    //private readonly embeddingUrl: string = process.env.OLLAMA_EMBEDDING_URL || 'http://localhost:11435';
    
    // Timeout configuration (in milliseconds)
    private readonly chatCompletionTimeout: number = parseInt(
        process.env.OLLAMA_CHAT_TIMEOUT ?? '1800000', 10
    ); // Default: 30 minutes

    private readonly embeddingTimeout: number = parseInt(
        process.env.OLLAMA_EMBEDDING_TIMEOUT ?? '12000000', 10
    ); // Default: 20 minutes

    constructor(private readonly http: HttpService) { }

    async chatCompletion(params: {
        messages: ChatMessage[];
        temperature?: number;
        maxTokens?: number;
        extra?: Record<string, any>;
    }) {
        const url = `${this.baseUrl}/v1/chat/completions`;
        const body = {
            model: process.env.LLM_MODEL ?? "llama3.3:70b-instruct-q3_K_M",
            messages: params.messages,
            temperature: params.temperature ?? 0.3,
            max_tokens: params.maxTokens ?? 1024,
            // Add keep_alive to prevent model reloading
            keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? "30m",
            ...(params.extra ?? {}),
        };

        try {            
            const resp = await firstValueFrom(
                this.http.post(url, body, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    timeout: this.chatCompletionTimeout,
                }),
            );    
            return resp.data;
        } catch (error) {
            throw new Error(error);
        }
    }

    async createEmbeddings(params: {
        input: string | string[];
        encodingFormat?: 'float' | 'base64';
    }) {
        //const url = `${this.baseUrl}/v1/embeddings`;
        const url = `http://localhost:11435/v1/embeddings`;
        const body = {
            model: process.env.EMBEDDING_MODEL ?? "bge-m3:latest",
            input: params.input
        };

        const resp = await firstValueFrom(
            this.http.post(url, body, {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 300000, // 30 seconds timeout
            })
        );
        
        const targetDim = parseInt(process.env.RAG_EMBED_DIM ?? '1024', 10);

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

        return { ...resp.data, data };
    }
}