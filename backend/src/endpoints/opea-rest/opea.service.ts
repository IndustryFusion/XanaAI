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

import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | 'function';

export interface ChatMessage {
    role: ChatRole;
    content: string;
}

export interface RerankDocument {
    text: string;
    id?: string;
}

export interface RerankResult {
    index: number;
    relevance_score: number;
    document?: RerankDocument;
}

@Injectable()
export class OpeaService {
    private readonly logger = new Logger(OpeaService.name);
    
    // OpenVINO Model Server (OVMS) backend endpoints
    private readonly ovmsBaseUrl: string;
    private readonly llmModelName: string;
    private readonly embeddingModelName: string;
    private readonly rerankModelName: string;
    
    // OPEA MegaService endpoints (optional - for full OPEA stack)
    private readonly chatUrl: string;
    private readonly embeddingUrl: string;
    private readonly rerankUrl: string;
    
    // Backend mode: 'ovms' (direct OpenVINO) or 'megaservice' (OPEA stack)
    private readonly backendMode: 'ovms' | 'megaservice';
    
    // Timeout configuration (in milliseconds)
    private readonly chatCompletionTimeout: number;
    private readonly embeddingTimeout: number;
    private readonly rerankTimeout: number;

    constructor(private readonly http: HttpService) {
        // Backend mode configuration
        this.backendMode = (process.env.OPEA_BACKEND_MODE || 'ovms') as 'ovms' | 'megaservice';
        
        // OpenVINO Model Server (OVMS) configuration - Use OPEA env vars from .env
        this.ovmsBaseUrl = process.env.OPEA_LLM_URL?.replace('/v3/chat/completions', '') || 'http://localhost:8000';
        this.llmModelName = process.env.OPEA_LLM_MODEL || 'meta-llama/Llama-3.3-70B-Instruct';
        this.embeddingModelName = process.env.OPEA_EMBEDDING_MODEL || 'BAAI/bge-m3';
        this.rerankModelName = process.env.OPEA_RERANK_MODEL || 'BAAI/bge-reranker-v2-m3';
        
        // OPEA MegaService endpoints (for megaservice mode)
        const megaServiceUrl = process.env.OPEA_MEGASERVICE_URL || 'http://localhost:8888';
        this.chatUrl = process.env.OPEA_CHAT_URL || `${megaServiceUrl}/v1/chatqna`;
        this.embeddingUrl = process.env.OPEA_EMBEDDING_URL || `${megaServiceUrl}/v1/embeddings`;
        this.rerankUrl = process.env.OPEA_RERANK_URL || `${megaServiceUrl}/v1/reranking`;
        
        // Timeouts
        this.chatCompletionTimeout = parseInt(
            process.env.OPEA_CHAT_TIMEOUT ?? '1800000', 
            10
        ); // Default: 30 minutes
        
        this.embeddingTimeout = parseInt(
            process.env.OPEA_EMBEDDING_TIMEOUT ?? '60000', 
            10
        ); // Default: 60 seconds
        
        this.rerankTimeout = parseInt(
            process.env.OPEA_RERANK_TIMEOUT ?? '60000', 
            10
        ); // Default: 60 seconds

        this.logger.log(`[OPEA] Initialized with backend mode: ${this.backendMode}`);
        
        if (this.backendMode === 'ovms') {
            this.logger.log(`[OPEA/OVMS] Configuration:`);
            this.logger.log(`  LLM: ${process.env.OPEA_LLM_URL} (model: ${this.llmModelName})`);
            this.logger.log(`  Embedding: ${process.env.OPEA_EMBEDDING_URL} (model: ${this.embeddingModelName})`);
            this.logger.log(`  Rerank: ${process.env.OPEA_RERANK_URL} (model: ${this.rerankModelName})`);
        } else {
            this.logger.log(`[OPEA/MegaService] Endpoints:`);
            this.logger.log(`  Chat: ${this.chatUrl}`);
            this.logger.log(`  Embedding: ${this.embeddingUrl}`);
            this.logger.log(`  Rerank: ${this.rerankUrl}`);
        }
    }

    /**
     * Chat completion using OPEA with OVMS backend or MegaService
     */
    async chatCompletion(params: {
        messages: ChatMessage[];
        temperature?: number;
        maxTokens?: number;
        extra?: Record<string, any>;
    }) {
        if (this.backendMode === 'ovms') {
            return this.chatCompletionOVMS(params);
        } else {
            return this.chatCompletionMegaService(params);
        }
    }

    /**
     * Chat completion via OpenVINO Model Server (OVMS)
     * Uses OpenAI-compatible API format
     */
    private async chatCompletionOVMS(params: {
        messages: ChatMessage[];
        temperature?: number;
        maxTokens?: number;
        extra?: Record<string, any>;
    }) {
        const url = process.env.OPEA_LLM_URL || `${this.ovmsBaseUrl}/v3/chat/completions`;
        
        const body = {
            model: params.extra?.model || this.llmModelName,
            messages: params.messages,
            temperature: params.temperature ?? 0.3,
            max_tokens: params.maxTokens ?? 1024,
            stream: false,
            ...(params.extra ?? {}),
        };

        try {
            this.logger.debug(`[OPEA/OVMS] Chat request to ${url} with model ${body.model}`);
            
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
            this.logger.error(`[OPEA/OVMS] Chat completion failed: ${error.message}`);
            throw new Error(`OPEA/OVMS chat completion failed: ${error.message}`);
        }
    }

    /**
     * Chat completion via OPEA MegaService (ChatQnA)
     */
    private async chatCompletionMegaService(params: {
        messages: ChatMessage[];
        temperature?: number;
        maxTokens?: number;
        extra?: Record<string, any>;
    }) {
        const body = {
            model: process.env.OPEA_LLM_MODEL ?? "meta-llama/Meta-Llama-3-8B-Instruct",
            messages: params.messages,
            temperature: params.temperature ?? 0.3,
            max_tokens: params.maxTokens ?? 1024,
            stream: false,
            ...(params.extra ?? {}),
        };

        try {
            this.logger.debug(`[OPEA/MegaService] Chat request to ${this.chatUrl}`);
            
            const resp = await firstValueFrom(
                this.http.post(this.chatUrl, body, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    timeout: this.chatCompletionTimeout,
                }),
            );
            
            return resp.data;
        } catch (error) {
            this.logger.error(`[OPEA/MegaService] Chat completion failed: ${error.message}`);
            throw new Error(`OPEA MegaService chat completion failed: ${error.message}`);
        }
    }

    /**
     * Create embeddings using OPEA with OVMS backend or MegaService
     */
    async createEmbeddings(params: {
        input: string | string[];
        encodingFormat?: 'float' | 'base64';
    }) {
        if (this.backendMode === 'ovms') {
            return this.createEmbeddingsOVMS(params);
        } else {
            return this.createEmbeddingsMegaService(params);
        }
    }

    /**
     * Create embeddings via OpenVINO Model Server (OVMS)
     * Uses OpenAI-compatible embeddings API
     */
    private async createEmbeddingsOVMS(params: {
        input: string | string[];
        encodingFormat?: 'float' | 'base64';
    }) {
        const url = process.env.OPEA_EMBEDDING_URL || `${this.ovmsBaseUrl}/v3/embeddings`;
        
        const body = {
            model: this.embeddingModelName,
            input: params.input,
            encoding_format: params.encodingFormat ?? 'float',
        };

        try {
            const inputCount = Array.isArray(params.input) ? params.input.length : 1;
            
            // Log embedding request details once per batch
            this.logger.log(`[OPEA/OVMS] Embedding ${inputCount} texts using ${url} with model ${this.embeddingModelName}`);
            
            const resp = await firstValueFrom(
                this.http.post(url, body, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    timeout: this.embeddingTimeout,
                })
            );
            
            const targetDim = parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1024', 10);

            // Fit embeddings to target dimension
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

            if (!(global as any).__logged_opea_ovms_embed_dim) {
                (global as any).__logged_opea_ovms_embed_dim = true;
                const got = resp.data?.data?.[0]?.embedding?.length;
                this.logger.log(`[OPEA/OVMS] Embedding dim: server=${got}, fitted to ${targetDim}`);
            }

            return { ...resp.data, data };
        } catch (error) {
            this.logger.error(`[OPEA/OVMS] Embedding failed: ${error.message}`);
            throw new Error(`OPEA/OVMS embedding failed: ${error.message}`);
        }
    }

    /**
     * Create embeddings via OPEA MegaService
     */
    private async createEmbeddingsMegaService(params: {
        input: string | string[];
        encodingFormat?: 'float' | 'base64';
    }) {
        const body = {
            model: process.env.OPEA_EMBEDDING_MODEL ?? "BAAI/bge-base-en-v1.5",
            input: params.input,
            encoding_format: params.encodingFormat ?? 'float',
        };

        try {
            const inputCount = Array.isArray(params.input) ? params.input.length : 1;
            
            // Log embedding request details once per batch
            this.logger.log(`[OPEA/MegaService] Embedding ${inputCount} texts using ${this.embeddingUrl} with model ${body.model}`);
            
            const resp = await firstValueFrom(
                this.http.post(this.embeddingUrl, body, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    timeout: this.embeddingTimeout,
                })
            );
            
            const targetDim = parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1024', 10);

            // Fit embeddings to target dimension
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

            if (!(global as any).__logged_opea_megaservice_embed_dim) {
                (global as any).__logged_opea_megaservice_embed_dim = true;
                const got = resp.data?.data?.[0]?.embedding?.length;
                this.logger.log(`[OPEA/MegaService] Embedding dim: server=${got}, fitted to ${targetDim}`);
            }

            return { ...resp.data, data };
        } catch (error) {
            this.logger.error(`[OPEA/MegaService] Embedding failed: ${error.message}`);
            throw new Error(`OPEA MegaService embedding failed: ${error.message}`);
        }
    }

    /**
     * Rerank documents using OPEA with OVMS backend or MegaService
     */
    async rerank(params: {
        query: string;
        documents: RerankDocument[];
        topN?: number;
        model?: string;
    }): Promise<RerankResult[]> {
        if (this.backendMode === 'ovms') {
            return this.rerankOVMS(params);
        } else {
            return this.rerankMegaService(params);
        }
    }

    /**
     * Rerank documents via OpenVINO Model Server (OVMS)
     * OVMS reranking API format
     */
    private async rerankOVMS(params: {
        query: string;
        documents: RerankDocument[];
        topN?: number;
        model?: string;
    }): Promise<RerankResult[]> {
        const url = process.env.OPEA_RERANK_URL || `${this.ovmsBaseUrl}/v3/rerank`;
        
        const body = {
            model: params.model || this.rerankModelName,
            query: params.query,
            documents: params.documents.map(doc => doc.text),
            top_n: params.topN ?? params.documents.length,
            return_documents: true,
        };

        try {
            this.logger.debug(`[OPEA/OVMS] Rerank request to ${url} for ${params.documents.length} documents`);
            
            const resp = await firstValueFrom(
                this.http.post(url, body, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    timeout: this.rerankTimeout,
                })
            );

            // Parse OVMS reranking response
            const results: RerankResult[] = (resp.data?.results ?? resp.data?.data ?? []).map((result: any, idx: number) => ({
                index: result.index ?? idx,
                relevance_score: result.relevance_score ?? result.score ?? 0.0,
                document: params.documents[result.index ?? idx],
            }));

            this.logger.debug(`[OPEA/OVMS] Reranked ${results.length} documents, top score: ${results[0]?.relevance_score?.toFixed(4)}`);

            return results;
        } catch (error) {
            this.logger.error(`[OPEA/OVMS] Reranking failed: ${error.message}`);
            throw new Error(`OPEA/OVMS reranking failed: ${error.message}`);
        }
    }

    /**
     * Rerank documents via OPEA MegaService
     */
    private async rerankMegaService(params: {
        query: string;
        documents: RerankDocument[];
        topN?: number;
        model?: string;
    }): Promise<RerankResult[]> {
        const body = {
            query: params.query,
            texts: params.documents.map(doc => doc.text),
            top_n: params.topN ?? params.documents.length,
            model: params.model ?? process.env.OPEA_RERANK_MODEL ?? "BAAI/bge-reranker-base",
        };

        try {
            this.logger.debug(`[OPEA/MegaService] Rerank request to ${this.rerankUrl} for ${params.documents.length} documents`);
            
            const resp = await firstValueFrom(
                this.http.post(this.rerankUrl, body, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    timeout: this.rerankTimeout,
                })
            );

            // Parse OPEA reranking response
            const results: RerankResult[] = (resp.data?.results ?? []).map((result: any, idx: number) => ({
                index: result.index ?? idx,
                relevance_score: result.relevance_score ?? result.score ?? 0.0,
                document: params.documents[result.index ?? idx],
            }));

            this.logger.debug(`[OPEA/MegaService] Reranked ${results.length} documents, top score: ${results[0]?.relevance_score?.toFixed(4)}`);

            return results;
        } catch (error) {
            this.logger.error(`[OPEA/MegaService] Reranking failed: ${error.message}`);
            throw new Error(`OPEA MegaService reranking failed: ${error.message}`);
        }
    }

    /**
     * Rerank hits from vector search
     * Returns reranked hits with updated scores
     */
    async rerankHits(params: {
        query: string;
        hits: Array<{ id: string; text: string; score: number }>;
        topK?: number;
    }): Promise<Array<{ id: string; text: string; score: number; rerank_score: number }>> {
        
        const documents: RerankDocument[] = params.hits.map(hit => ({
            text: hit.text,
            id: hit.id,
        }));

        const rerankResults = await this.rerank({
            query: params.query,
            documents: documents,
            topN: params.topK ?? params.hits.length,
        });

        // Map rerank results back to hits format
        const rerankedHits = rerankResults.map(result => {
            const originalHit = params.hits[result.index];
            return {
                id: originalHit.id,
                text: originalHit.text,
                score: originalHit.score, // Original vector similarity score
                rerank_score: result.relevance_score, // New reranking score
            };
        });

        // Sort by rerank score descending
        rerankedHits.sort((a, b) => b.rerank_score - a.rerank_score);

        return rerankedHits;
    }
}
