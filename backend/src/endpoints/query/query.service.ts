//*****************************************************************************
// Portions Copyright 2025 Intel Corporation
// Author: Intel Corporation (yatindra.shashi@intel.com)
// These modifications are the responsibility of Intel Corporation and cover
// functions specifically changed to support local Ollama and OPEA with OpenVINO
// model server based LLM, embedding, reranking hosting backend integration.
//
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
//*****************************************************************************

import { Injectable, Logger, BadRequestException, InternalServerErrorException, UnauthorizedException, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { MilvusRagService } from '../ionos-rest/milvus.service';
import { IonosService } from '../ionos-rest/ionos.service';
import { OllamaService } from '../ollama-rest/ollama.service';
import { OpeaService } from '../opea-rest/opea.service';
import { Pool } from 'pg';
import { createHash } from 'crypto';
import { CompactEncrypt } from 'jose';
import axios from 'axios';
import { FindIndexedDbAuthDto } from './dto/find-auth.dto';
import * as jwt from 'jsonwebtoken';

type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | 'function';

interface ChatMsg {
    role: ChatRole;
    content: string;
}

interface ChartIntent {
    wants_chart: boolean;
    asset_urn?: string | null;
    metric?: string | null;
    last?: {
        value: number;
        unit: 'm' | 'h' | 'd' | 'w';
    } | null;
    from?: string | null;
    to?: string | null;
}

type AlertIntent = {
    wants_alert: boolean;
    asset_urn?: string | null;
};

type ChartMeta = {
    assetUrn: string;
    metric?: string;
    source: 'postgrest' | 'postgres';
};

interface TimeSeriesPoint {
    t: string;
    v: number;
}

interface ChartResult {
    series: TimeSeriesPoint[];
    meta: {
        assetUrn: string;
        metric?: string;
        source: string;
    };
}

type AlertResult = {
    alerts: Array<{ t: string; v: number }>;
    meta: AlertaMeta;
};

type AlertaMeta = {
    assetUrn: string;
    source: 'alerta';
};

type ChartPoint = { t: number | string; v: number };

interface ChartSummary {
    summary: string;
    first10: TimeSeriesPoint[];
    last10: TimeSeriesPoint[];
}

interface ChunkDoc {
    name: string;
    contentType: string;
    vector: number[];
    labels: Record<string, any>;
    url?: string;
}

@Injectable()
export class QueryService {
    private readonly log = new Logger(QueryService.name);
    private pgPool?: Pool;
    private readonly SECRET_KEY = process.env.SECRET_KEY;
    private readonly MASK_SECRET = process.env.MASK_SECRET;
    private readonly registryUrl = process.env.REGISTRY_URL;

    constructor(
        private readonly http: HttpService,
        private readonly ionosService: IonosService,
        private readonly ollamaService: OllamaService,
        private readonly opeaService: OpeaService,
        private readonly milvusService: MilvusRagService,
    ) {
        const hasPg = !!process.env.PGHOST;
        if (hasPg) {
            this.pgPool = new Pool({
                host: process.env.PGHOST,
                port: Number(process.env.PGPORT) || 5432,
                user: process.env.PGUSER || 'dbreader',
                password: process.env.PGPASSWORD,
                database: process.env.PGDATABASE || 'tsdb',
                ssl:
                    process.env.PGSSL === "true"
                        ? { rejectUnauthorized: false } // ignores self-signed cert
                        : false,
            });
        }
    }

    private flattenChatHistoryToString(messages: ChatMsg[]): string {
        return messages
            .filter(m => typeof m.content === 'string' && m.content.trim().length > 0)
            .map(m => `${m.role}: ${m.content.trim()}`)
            .join('\n');
    }

    async fetchSeriesFromPostgres(
        assetUrn: string,
        metric: string | undefined,
        from: string,
        to: string,
    ): Promise<ChartResult> {
        if (!this.pgPool) {
            throw new Error('PostgreSQL not configured');
        }

        const table = process.env.PG_TABLE ?? 'entityhistory';
        const sql = `
            SELECT *
            FROM ${table}
            WHERE "entityId" = $1
            AND "attributeId" = $2
            AND "observedAt" >= $3
            AND "observedAt" <  $4
            ORDER BY "observedAt" DESC
            LIMIT 100;
        `;

        let series: TimeSeriesPoint[] = [];

        try {
            const res = await this.pgPool.query(sql, [assetUrn, "https://industry-fusion.org/base/v0.1/" + metric, from, to]);
            series = res.rows.map(r => ({
                t: r.observedAt,
                v: parseFloat(r.value) || 0,
            }));
        } catch (error) {
            this.log.error('PostgreSQL query failed:', error);
        }

        return {
            series,
            meta: {
                assetUrn,
                metric,
                source: 'postgres'
            },
        };
    }


    async fetchAlertData(
        assetUrn: string
    ): Promise<AlertResult> {
        let alerts = [];

        try {
            const resAlerts = await axios.get(process.env.ALERTA_API_URL + '?resource=' + assetUrn, {
                headers: {
                    'Authorization': `Key ${process.env.ALERTA_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            alerts = resAlerts.data.alerts || [];


        } catch (error) {
            this.log.error('Error fetching alerts:', error);
        }

        return {
            alerts,
            meta: {
                assetUrn,
                source: 'alerta'
            }
        };
    }

    /**
     * If the latest user message asks for a chart of a specific asset URN,
     * fetch live data from PostgREST (preferred) or Postgres and return it.
     * Otherwise return null.
     */


    async detectChartIntentWithLLM(lastUserText: string): Promise<ChartIntent> {
        const schema = {
            name: 'chart_intent',
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    wants_chart: { type: 'boolean' },
                    asset_urn: { type: ['string', 'null'] },
                    metric: { type: ['string', 'null'] },
                    last: {
                        type: ['object', 'null'],
                        additionalProperties: false,
                        properties: {
                            value: { type: 'integer' },
                            unit: { type: 'string', enum: ['m', 'h', 'd', 'w'] },
                        },
                        required: ['value', 'unit'],
                    },
                    from: { type: ['string', 'null'], description: 'ISO datetime' },
                    to: { type: ['string', 'null'], description: 'ISO datetime' },
                },
                required: ['wants_chart'],
            },
            strict: true,
        };

        const prompt =
            `You extract data chart intent from a single user message.\n` +
            `- If the user asks for a chart/plot/graph/trend or with an id, ignore alerts or notification queries, set wants_chart=true.\n` +
            `- Extract the asset URN exactly if present (e.g., "urn:iff:asset:123"). if else, send null.\n` +
            `- If a range like "last 24h/7d/30m" is present, fill last {value,unit}.\n` +
            `- Be strict in decision, if in doubt assume that there is no intent.\n` +
            `- If explicit dates exist, set from/to as ISO. if not present, send null for those. The format must match 2025-09-01T21:58:35.808 \n` +
            `- metric is optional but fetch it. if two words present use like ab_ba (e.g., temperature, power, load, rpm, pressure, current, voltage, speed, energy, consumption).\n` +
            `Return pure JSON object in this format ${JSON.stringify(schema)}.\n\n` +
            `User: ${lastUserText}`;

        // FIXED: Use LLM provider based on environment configuration
        const llmProvider = process.env.LLM_PROVIDER || 'ionos'; // add directly from UI
        this.log.log(`[CHART_INTENT] Using LLM provider: ${llmProvider}`);

        let r;
        if (llmProvider === 'ollama') {
            this.log.log('[CHART_INTENT] Calling Ollama for chart intent detection');
            r = await this.ollamaService.chatCompletion({
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                maxTokens: 250
            });
        } else if (llmProvider === 'opea') {
            this.log.log('[CHART_INTENT] Calling OPEA-OVMS for chart intent detection');
            r = await this.opeaService.chatCompletion({
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                maxTokens: 250
            });
            // this.log.log('[CHART_INTENT] OPEA raw response:', JSON.stringify(r, null, 2));
        } else {
            this.log.log('[CHART_INTENT] Calling IONOS for chart intent detection');
            r = await this.ionosService.chatCompletion({
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                maxTokens: 250
            });
        }

        this.log.debug('Chart intent response:', r);

        const content = (r as any)?.choices?.[0]?.message?.content;

        function asString(x: any): string {
            if (typeof x === 'string') return x;
            if (x == null) return '';
            if (typeof x === 'object') {
                if (x.content && typeof x.content === 'string') return x.content;
                if (x.text && typeof x.text === 'string') return x.text;
                if (x.message && typeof x.message === 'string') return x.message;
                return JSON.stringify(x);
            }
            return String(x);
        }

        const out = asString(content);
        const cleaned = out.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

        this.log.debug('Chart intent cleaned response:', cleaned);

        try {
            return JSON.parse(cleaned);
        } catch (err) {
            this.log.warn('Failed to parse chart intent JSON:', cleaned);
            return { wants_chart: false };
        }
    }

    async detectAlertIntentWithLLM(lastUserText: string): Promise<AlertIntent> {
        const schema = {
            name: 'chart_intent',
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    wants_alert: { type: 'boolean' },
                    asset_urn: { type: ['string', 'null'] },
                },
                required: ['wants_alert'],
            },
            strict: true,
        };

        const prompt =
            `You extract data alert intent from a single user message.\n` +
            `- If the user asks for an alert or alerts or notifications and you know better, set wants_alert=true.\n` +
            `- Extract the asset URN exactly if present (e.g., "urn:iff:asset:123").\n` +
            `- Be strict in decision, if in doubt assume that there is no intent.\n` +
            `Return pure JSON object in this format ${schema}.\n\n` +
            `User: ${lastUserText}`;

        const r = await this.ionosService.chatCompletion({
            messages: [
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            maxTokens: 250
        });

        this.log.debug('Alert intent response:', r);

        const content = (r as any)?.choices?.[0]?.message?.content;

        // 2) coerce to string (handles string | array | object)
        function asString(x: any): string {
            if (typeof x === 'string') return x;
            if (Array.isArray(x)) {
                // e.g. Responses API style: [{type:'output_text', text:'...'}] or {text:{value:'...'}}
                return x.map(p =>
                    typeof p === 'string' ? p
                        : typeof p?.text === 'string' ? p.text
                            : typeof p?.text?.value === 'string' ? p.text.value
                                : ''
                ).filter(Boolean).join('\n');
            }
            if (x && typeof x === 'object') return JSON.stringify(x);
            return '';
        }

        let out = asString(content);

        // 3) strip code fences if present
        let cleaned = out.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

        this.log.debug('Chart intent response:', cleaned);
        // cleaned = cleaned
        //     .replace(/```(?:json)?/g, '') // remove code fences
        //     .trim();

        // cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z0-9_]+)(\s*:)/g, '$1"$2"$3');

        try {
            return JSON.parse(cleaned) as AlertIntent;
        } catch (err) {
            this.log.error('Error parsing alert intent response:', err);
            return { wants_alert: false };
        }
    }

    async maybeGetChartData(messages: ChatMsg[]): Promise<ChartResult | null> {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (!lastUser) return null;

        const nlu = await this.detectChartIntentWithLLM(lastUser.content);
        if (!nlu.wants_chart || !nlu.asset_urn) return null;

        let from = "";
        let to = "";
        if (nlu.from) from = nlu.from;
        if (nlu.to) to = nlu.to;

        const metric = nlu.metric ?? undefined;

        if (
            this.pgPool &&
            typeof nlu.asset_urn === 'string' &&
            from &&
            to
        ) {
            return await this.fetchSeriesFromPostgres(nlu.asset_urn, metric, from, to);
        }
        return null;
    }

    async maybeGetAlertData(messages: ChatMsg[]): Promise<AlertResult | null> {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (!lastUser) return null;

        // 1) LLM NLU
        const nlu = await this.detectAlertIntentWithLLM(lastUser.content);
        if (!nlu.wants_alert || !nlu.asset_urn) return null;

        if (
            typeof nlu.asset_urn === 'string'
        ) {
            return this.fetchAlertData(
                nlu.asset_urn,
            );
        }
        return null;
    }

    private formatChartSummary(chart: ChartResult): ChartSummary {
        const { assetUrn, metric } = chart.meta;
        const pts = chart.series.length;
        const first10 = chart.series.slice(0, 100);
        const last10 = chart.series.slice(Math.max(0, pts - 100));

        const vals = chart.series.map(p => p.v).filter(v => Number.isFinite(v));
        const min = vals.length ? Math.min(...vals) : null;
        const max = vals.length ? Math.max(...vals) : null;

        const summary = [
            `Live data (${metric ?? 'metric'}) for ${assetUrn}`,
            `Points: ${pts}${min !== null && max !== null ? `, Min: ${min}, Max: ${max}` : ''}`,
        ].join('\n');

        return { summary, first10, last10 };
    }

    async getChartSummaryIfAny(messages: ChatMsg[]): Promise<{ chart?: ChartResult; summary?: string; first10?: TimeSeriesPoint[]; last10?: TimeSeriesPoint[]; message?: string } | null> {
        let chart: ChartResult | null = null;
        try {
            chart = await this.maybeGetChartData(messages);
        } catch (error) {
            this.log.error('Chart data fetch failed:', error);
        }

        if (chart?.series && chart.series.length > 0) {
            const formatted = this.formatChartSummary(chart);
            return { chart, ...formatted };
        } else if (chart?.series.length === 0) {
            return { message: 'Make sure you have mentioned asset ID, metric, from and to dates.' };
        }

        return null;
    }

    async getAlertsDataIfAny(messages: ChatMsg[]): Promise<Record<string, any> | null> {
        let alert: AlertResult | null = null;
        try {
            alert = await this.maybeGetAlertData(messages);
        } catch { /* ignore chart errors */ }

        // Optionally inform the model that live data is attached:
        if (alert?.alerts) {
            // ✅ Privacy mode: DO NOT call OpenAI at all
            // Optionally prepend a short human message explaining it’s live data:
            const reply =
                `Here’s the live alerts:\n\n`
            return { reply, alerts: alert?.alerts }; // you can also return `series` for the frontend to plot
        }
        else if (alert?.alerts.length === 0) {
            // Handle empty series case
            const reply = `No live data available for ${alert.meta.assetUrn}.`;
            return { reply, alerts: alert?.alerts };
        } else {
            // Handle other cases
            return null;
        }
    }


    async milvusSearch(messages, hostProvider): Promise<{ contextText: string; sources: any[] }> {
        let question = "";
        for (const m of messages) {
            if (m.role === 'user') {
                question += m.content + " ";
            }
        }
        question = question.trim();

        this.log.log(`[QUERY] About to send question for embedding. Length: ${question.length} characters`);
        this.log.log(`[QUERY] Question content preview: ${question.substring(0, 200)}...`);

        const embeddingProvider = hostProvider || process.env.EMBEDDING_PROVIDER || 'ollama'; // here also take UI
        let embeddingForQuestion;

        if (embeddingProvider === 'ollama') {
            embeddingForQuestion = await this.ollamaService.createEmbeddings({ input: question });
        } else if (embeddingProvider === 'opea') {
            embeddingForQuestion = await this.opeaService.createEmbeddings({ input: question });
        } else {
            embeddingForQuestion = await this.ionosService.createEmbeddings({ input: question });
        }

        const questionVector = embeddingForQuestion.data[0].embedding;

        const vectorProvider = process.env.VECTOR_PROVIDER || 'milvus';
        const collectionName = process.env.RAG_COLLECTION_NAME || 'custom_setup_7';
        
        // Get topK from environment variable
        const topK = parseInt(process.env.RETRIEVE_TOP_K || '5', 10);
        let useReranker = false;
        if(embeddingProvider === 'opea'){
            // If OPEA embeddings are used, we might want to adjust topK
            this.log.log(`[QUERY] Using OPEA embeddings, adjusting topK if necessary.`);
            useReranker = true;
        }
        else{
            useReranker = (process.env.USE_RERANKER || 'false').toLowerCase() === 'true';
        }

        // Retrieve more candidates for reranking (e.g., 3x topK, max 20)
        const retrieveK = useReranker ? Math.min(topK * 3, 20) : topK;
        this.log.log(`[QUERY] Retrieving top-${retrieveK} candidates${useReranker ? ' for reranking' : ''}`);

        const rawResults = await this.milvusService.search(
            collectionName,
            questionVector,
            retrieveK
        );

        this.log.log(`[QUERY] Raw ${vectorProvider} results:`, JSON.stringify(rawResults, null, 2));

        let searchResults: any[] = [];
        if (Array.isArray(rawResults)) {
            searchResults = rawResults;
        } else if (rawResults && Array.isArray(rawResults[0])) {
            searchResults = rawResults[0];
        } else if (rawResults && rawResults.data && Array.isArray(rawResults.data)) {
            searchResults = rawResults.data;
        } else {
            this.log.warn(`[QUERY] Unexpected rawResults structure:`, typeof rawResults);
            searchResults = [];
        }

        this.log.log(`[QUERY] Final searchResults type: ${typeof searchResults} isArray: ${Array.isArray(searchResults)} length: ${searchResults.length}`);

        // Helper function to extract text from various formats
        function coerceLabels(input: unknown): Record<string, any> {
            if (input == null) return {};
            if (typeof input === 'string') {
                try {
                    const parsed = JSON.parse(input);
                    return typeof parsed === 'object' && parsed !== null ? parsed : {};
                } catch {
                    return { text: input };
                }
            }
            if (typeof input === 'object' && input !== null) {
                return input as Record<string, any>;
            }
            return {};
        }

        // Apply reranking if enabled (useReranker already declared above)
        const rerankProvider = process.env.RERANKER_PROVIDER || 'opea';
        
        if (useReranker && rerankProvider === 'opea' && searchResults.length > 0) {
            this.log.log(`[QUERY] Applying OPEA-OVMS reranking to ${searchResults.length} results`);
            
            try {
                // Prepare hits for reranking - extract text from Milvus response
                const hits = searchResults.map(hit => {
                    const labels = coerceLabels(hit.labels || hit.entity || hit);
                    const text = labels.text || hit.text || hit.content || '';
                    
                    return {
                        id: hit.id || hit.chunk_id || String(Math.random()),
                        text: text,
                        score: hit.score || hit.distance || 0
                    };
                });
                
                const reranked = await this.opeaService.rerankHits({
                    query: question,
                    hits: hits,
                    topK: topK
                });

                this.log.log(`[QUERY] Reranking complete: ${reranked.length} results returned`);
                if (reranked.length > 0) {
                    this.log.log(`[QUERY] Top rerank score: ${reranked[0].rerank_score.toFixed(4)}, Bottom: ${reranked[reranked.length - 1].rerank_score.toFixed(4)}`);
                }

                // Replace searchResults with reranked results
                searchResults = reranked;

                this.log.log(`[QUERY] Using ${searchResults.length} reranked results for context`);
            } catch (error) {
                this.log.error(`[QUERY] Reranking failed: ${error.message}, using original results`);
                // Continue with original searchResults if reranking fails
            }
        } else if (useReranker) {
            this.log.log(`[QUERY] Reranking disabled or no results to rerank`);
        }

        const contextText = (Array.isArray(searchResults) ? searchResults : [])
            .map((hit, i) => {
                const labels = coerceLabels(hit.labels || hit.entity || hit);
                const text = labels.text || hit.text || hit.content || JSON.stringify(labels);
                const source = labels.source || labels.filename || hit.filename || `doc-${i}`;
                const score = hit.score || hit.distance || 'N/A';

                return `[${source}] (score: ${score})\n${text}`;
            })
            .filter(s => s && s.length > 4)
            .join('\n\n-----\n\n');
        return { contextText, sources: Array.isArray(searchResults) ? searchResults : [] };
    }

    private mask(input: string, key: string): string {
        return input.split('').map((char, i) =>
            (char.charCodeAt(0) ^ key.charCodeAt(i % key.length)).toString(16).padStart(2, '0')
        ).join('');
    }

    private unmask(masked: string, key: string): string {
        if (!key) {
            throw new Error('Mask secret not defined');
        }
        const bytes = masked.match(/.{1,2}/g)!.map((h) => parseInt(h, 16));
        return String.fromCharCode(
            ...bytes.map((b, i) => b ^ key.charCodeAt(i % key.length))
        );
    }

    deriveKey(secret: string): Uint8Array {
        const hash = createHash('sha256');
        hash.update(secret);
        return new Uint8Array(hash.digest());
    }

    async encryptData(data: string): Promise<string> {
        const encoder = new TextEncoder();
        if (!this.SECRET_KEY) {
            throw new Error('SECRET_KEY not defined');
        }
        const encryptionKey = await this.deriveKey(this.SECRET_KEY);

        const encrypted = await new CompactEncrypt(encoder.encode(data))
            .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
            .encrypt(encryptionKey);
        return encrypted;
    }

    async getIndexedData(data: FindIndexedDbAuthDto) {
        try {
            const routeToken = data.token
            const { m: maskedJwt } = jwt.verify(routeToken, this.SECRET_KEY) as { m: string };
            if (!this.MASK_SECRET) {
                throw new Error("MASK_SECRET is not defined");
            }
            const registryJwt = this.unmask(maskedJwt, this.MASK_SECRET);
            const decoded = jwt.decode(registryJwt) as
                | { sub?: string; user?: string; iat?: number; exp?: number }
                | null;


            if (!decoded) {
                throw new HttpException('Cannot decode registryJwt', HttpStatus.UNAUTHORIZED);
            }

            const registryHeader = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                Authorization: `Bearer ${registryJwt}`,
            };
            const registryResponse = await axios.post(
                `${this.registryUrl}/auth/get-indexed-db-data`,
                {
                    company_id: decoded.sub,
                    email: decoded.user,
                    product_name: data.product_name,
                },
                { headers: registryHeader },
            );
            if (registryResponse.data) {
                const encryptedToken = await this.encryptData(registryResponse.data.data.jwt_token);
                registryResponse.data.data.ifricdi = this.mask(encryptedToken, this.MASK_SECRET);
                registryResponse.data.data.jwt_token = registryJwt;
                return registryResponse.data;
            }
        } catch (err) {
            if (err instanceof jwt.TokenExpiredError) {
                throw new UnauthorizedException('Token has expired');
            }
            if (err?.response?.status == 401) {
                throw new UnauthorizedException();
            }
            throw new NotFoundException(`Failed to fetch indexed data: ${err.message}`);
        }

    }

    async addDocument(docData: {
        name: string;
        text: string;
        contentType?: string;
        url?: string;
        metadata?: Record<string, any>;
    }): Promise<void> {
        const embeddingProvider = process.env.EMBEDDING_PROVIDER || 'ionos';
        let embeddingResponse;

        if (embeddingProvider === 'ollama') {
            embeddingResponse = await this.ollamaService.createEmbeddings({ input: docData.text });
        } else if (embeddingProvider === 'opea') {
            embeddingResponse = await this.opeaService.createEmbeddings({ input: docData.text });
        } else {
            embeddingResponse = await this.ionosService.createEmbeddings({ input: docData.text });
        }

        const vector = embeddingResponse.data[0].embedding;

        const chunkDoc: ChunkDoc = {
            name: docData.name,
            contentType: docData.contentType || 'text/plain',
            vector: vector,
            labels: {
                text: docData.text,
                ...docData.metadata
            },
            url: docData.url
        };

        const vectorProvider = process.env.VECTOR_PROVIDER || 'milvus';
        const collectionName = process.env.RAG_COLLECTION_NAME || 'custom_setup_7';

        await this.milvusService.addDocuments(collectionName, [chunkDoc]);
    }

    async handleQuery({
        hostProvider,
        messages,
        vectorStoreIds,
        assets
    }: {
        messages: ChatMsg[];
        vectorStoreIds: string[];
        hostProvider: 'ionos' | 'ollama' | 'opea';
        assets: string[]
    }): Promise<Record<string, any>> {
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new BadRequestException('Messages array is required and cannot be empty');
        }

        // Create enhanced messages with assets information
        let enhancedMessages = [...messages];
        if (vectorStoreIds && vectorStoreIds.length > 0) {
            const assetInfo: ChatMsg = {
                role: 'user',
                content: `Find Information for product ${vectorStoreIds.join(', ')}.`
            };
            
            // Prepend asset information as first message
            enhancedMessages = [assetInfo, ...messages];
        }
        
        const systemPrompt: ChatMsg = {
            role: 'system',
            content: `You are XANA — an industrial machine support assistant for shop-floor operators and technicians.
- Use provided machine files/context first; quote exact parameter names, menu paths, and setpoints from docs, and dont tell that you are provided a context.
- If docs are empty or unrelated, say so briefly and continue with best-practice guidance.
- Safety first: never suggest bypassing interlocks/guards; reference E-Stop and LOTO when relevant.
- Style: short, scannable, practical; metric units; don't invent values. If uncertain, say "Not enough data" and ask one targeted question.
- Include preventive maintenance tips, part numbers, and specs only if present in the data.
- selected asset or product name explicitly for questions by the user is ${vectorStoreIds.join(', ')}, if there two machine or product names, ask which one user means.`,
        };

        let fullContext = '';
        // Only check for chart intent if flag is not set to skip
        const ChartIntent = process.env.CHART_INTENT || 'true';
        if (ChartIntent !== 'false') {
            this.log.log('[QUERY] Checking for chart intent...');
            const chartSummary = await this.getChartSummaryIfAny(enhancedMessages);
            if (chartSummary) {
                this.log.log('[QUERY] Chart intent detected, returning chart summary');
                return chartSummary;
            }
        } else {
            this.log.log('[QUERY] Skipping chart intent check as requested');
        }

        const b = await this.getAlertsDataIfAny(enhancedMessages);
        if (b !== null) {
            return b;
        }
        // Add context to systemPrompt here from IONOS collection query match

        const { contextText, sources } = await this.milvusSearch(enhancedMessages, hostProvider);

        fullContext = contextText;
        if (fullContext.trim()) {
            fullContext = `\n\n--- Context ---\n${fullContext}`;
        }

        const fullHistory = [systemPrompt, ...enhancedMessages];
        if (fullContext.trim()) {
            const lastUserIdx = fullHistory.map((m, i) => ({ ...m, idx: i }))
                .reverse()
                .find(m => m.role === 'user')?.idx;

            if (lastUserIdx !== undefined) {
                fullHistory[lastUserIdx] = {
                    ...fullHistory[lastUserIdx],
                    content: `${fullHistory[lastUserIdx].content}\n\n--- Context ---\n${fullContext}`,
                };
            }
        }

        try {
            // Use LLM provider based on environment configuration only
            const llmProvider = hostProvider || process.env.LLM_PROVIDER || 'ionos';
            this.log.log(`[MAIN_QUERY] Using LLM provider: ${llmProvider}`);

            // Calculate and log context metrics
            const totalMessages = fullHistory.length;
            const totalChars = fullHistory.reduce((sum, msg) => sum + msg.content.length, 0);
            const systemPromptChars = fullHistory[0]?.content.length || 0;
            const contextChars = fullContext.length;
            const estimatedTokens = Math.ceil(totalChars / 4); // Rough estimate: 1 token ≈ 4 chars
            
            this.log.log(`[MAIN_QUERY] ===== LLM CALL CONTEXT METRICS =====`);
            this.log.log(`[MAIN_QUERY] Total messages: ${totalMessages}`);
            this.log.log(`[MAIN_QUERY] System prompt length: ${systemPromptChars} chars`);
            this.log.log(`[MAIN_QUERY] Retrieved context length: ${contextChars} chars`);
            this.log.log(`[MAIN_QUERY] Total prompt length: ${totalChars} chars`);
            this.log.log(`[MAIN_QUERY] Estimated tokens: ~${estimatedTokens} tokens`);
            this.log.log(`[MAIN_QUERY] Number of sources: ${sources.length}`);
            if (vectorStoreIds && vectorStoreIds.length > 0) {
                this.log.log(`[MAIN_QUERY] Assets in context: ${vectorStoreIds.join(', ')}`);
                this.log.log(`[MAIN_QUERY] Enhanced messages with asset info`);
            }
            this.log.log(`[MAIN_QUERY] =====================================`);

            let completion;
            if (llmProvider === 'ollama') {
                this.log.log('[MAIN_QUERY] Calling Ollama for main query completion');
                completion = await this.ollamaService.chatCompletion({
                    messages: fullHistory,
                    temperature: 0.3,
                    maxTokens: 1500,
                });
            } else if (llmProvider === 'opea') {
                this.log.log('[MAIN_QUERY] Calling OPEA-OVMS for main query completion');
                completion = await this.opeaService.chatCompletion({
                    messages: fullHistory,
                    temperature: 0.3,
                    maxTokens: 1500,
                });
                this.log.log('[MAIN_QUERY] OPEA raw answer:', JSON.stringify(completion, null, 2));
            } else {
                this.log.log('[MAIN_QUERY] Calling IONOS for main query completion');
                completion = await this.ionosService.chatCompletion({
                    messages: fullHistory,
                    temperature: 0.3,
                    maxTokens: 1500,
                });
            }
            // const chosenId = await this.routeVectorStoreId(questionForRouter, ids, assets);
            // ids = [chosenId];

            return {
                reply: completion.choices[0].message.content,
                sources: sources.slice(0, 3),
            };
        } catch (error) {
            this.log.error('LLM call failed:', error);
            throw new InternalServerErrorException('Failed to generate response');
        }
    }
}
