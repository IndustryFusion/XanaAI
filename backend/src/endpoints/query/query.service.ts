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

import { Injectable, BadRequestException, InternalServerErrorException, HttpException, HttpStatus, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { IonosService } from '../ionos-rest/ionos.service';
import { MilvusRagService } from '../ionos-rest/milvus.service';
import { FindIndexedDbAuthDto } from './dto/find-auth.dto';
import * as jwt from 'jsonwebtoken';
import axios from 'axios';
import { createHash } from 'crypto';
import { CompactEncrypt } from 'jose';

type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool' | 'function'; content: string };
type ChartIntent = {
    wants_chart: boolean;
    asset_urn?: string | null;
    metric?: string | null;
    // either last {value,unit} OR explicit ISO from/to
    last?: { value: number; unit: 'm' | 'h' | 'd' | 'w' } | null;
    from?: string | null;
    to?: string | null;
};

type AlertIntent = {
    wants_alert: boolean;
    asset_urn?: string | null;
};

type ChartMeta = {
    assetUrn: string;
    metric?: string;
    source: 'postgrest' | 'postgres';
};

type ChartResult = {
    series: Array<{ t: string; v: number }>;
    meta: ChartMeta;
};

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
    first10: ChartPoint[];
    last10: ChartPoint[];
}

@Injectable()
export class QueryService {
    private pgPool?: Pool;
    private readonly SECRET_KEY = process.env.SECRET_KEY;
    private readonly MASK_SECRET = process.env.MASK_SECRET;
    private readonly registryUrl = process.env.REGISTRY_URL;

    constructor(private readonly ionosservice: IonosService, private readonly milvusservice: MilvusRagService) {
        const hasPg = !!process.env.PGHOST;
        if (hasPg) {
            this.pgPool = new Pool({
                host: process.env.PGHOST,
                port: Number(process.env.PGPORT ?? 5432),
                user: "dbreader",
                password: process.env.PGPASSWORD,
                database: "tsdb",
                ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
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
        if (!this.pgPool) throw new Error('Postgres pool not initialized');

        const table = process.env.PG_TABLE ?? 'entityhistory';
        // Adjust column names to your schema
        // const sql = `
        //     SELECT id, entityId
        //     FROM ${table}
        //     WHERE entityId = $1
        //         AND ($2::text IS NULL OR metric = $2::text)
        //         AND ts BETWEEN $3::timestamptz AND $4::timestamptz
        //     ORDER BY ts ASC
        //     LIMIT 5;
        // `;

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

        // const { rows } = await this.pgPool.query(sql, [
        //     assetUrn,
        //     "https://industry-fusion.org/base/v0.1/" + metric ?? null,
        //     from,
        //     to,
        // ]);
        let series: { t: string; v: number }[] = [];

        try {
            const { rows } = await this.pgPool.query(sql, [assetUrn, "https://industry-fusion.org/base/v0.1/" + (metric ?? null), from, to]);
            series = rows.map((r: any) => ({ t: new Date(r.observedAt).toISOString(), v: Number(r.value) }));


        } catch (error) {
            console.error('Error fetching series from Postgres:', error);
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
            const resAlerts = await axios.get(process.env.ALERTA_API_URL + '?resource=' + assetUrn , {
                headers: {
                    'Authorization': `Key ${process.env.ALERTA_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            alerts = resAlerts.data.alerts || [];


        } catch (error) {
            console.error('Error fetching alerts:', error);
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
            `- Extract the asset URN exactly if present (e.g., "urn:iff:asset:123"). if else, a product name or some string is present.\n` +
            `- If a range like "last 24h/7d/30m" is present, fill last {value,unit}.\n` +
            `- Be strict in decision, if in doubt assume that there is no intent.\n` +
            `- If explicit dates exist, set from/to as ISO. if not present, take CEST from yesterday to today. The format must match 2025-08-14T12:36:04.868Z \n` +
            `- metric is optional but fetch it. if two words present use like ab_ba (e.g., temperature, power, load, rpm, pressure, current, voltage, speed, energy, consumption).\n` +
            `Return pure JSON object in this format ${schema}.\n\n` +
            `User: ${lastUserText}`;

        const r = await this.ionosservice.chatCompletion({
            messages: [
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            maxTokens: 250
        });

        console.log('Chart intent response:', r);

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

        console.log('Chart intent response:', cleaned);
        // cleaned = cleaned
        //     .replace(/```(?:json)?/g, '') // remove code fences
        //     .trim();

        // cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z0-9_]+)(\s*:)/g, '$1"$2"$3');

        try {
            return JSON.parse(cleaned) as ChartIntent;
        } catch (err) {
            console.error('Error parsing chart intent response:', err);
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

        const r = await this.ionosservice.chatCompletion({
            messages: [
                { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            maxTokens: 250
        });

        console.log('Alert intent response:', r);

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

        console.log('Chart intent response:', cleaned);
        // cleaned = cleaned
        //     .replace(/```(?:json)?/g, '') // remove code fences
        //     .trim();

        // cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z0-9_]+)(\s*:)/g, '$1"$2"$3');

        try {
            return JSON.parse(cleaned) as AlertIntent;
        } catch (err) {
            console.error('Error parsing alert intent response:', err);
            return { wants_alert: false };
        }
    }


    async maybeGetChartData(messages: ChatMsg[]): Promise<ChartResult | null> {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (!lastUser) return null;

        // 1) LLM NLU
        const nlu = await this.detectChartIntentWithLLM(lastUser.content);
        if (!nlu.wants_chart || !nlu.asset_urn) return null;

        // 2) Resolve time window
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
            return this.fetchSeriesFromPostgres(
                nlu.asset_urn,
                metric ?? undefined,
                from,
                to
            );
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

        // simple stats (safe on server)
        const vals = chart.series.map(p => p.v).filter(v => Number.isFinite(v));
        const min = vals.length ? Math.min(...vals) : null;
        const max = vals.length ? Math.max(...vals) : null;

        const summary = [
            `Live data (${metric ?? 'metric'}) for ${assetUrn}`,
            `Points: ${pts}${min !== null && max !== null ? `, Min: ${min}, Max: ${max}` : ''}`,
        ].join('\n');

        return { summary, first10, last10 };
    }


    async getChartSummaryIfAny(messages: ChatMsg[]): Promise<Record<string, any> | null> {
        let chart: ChartResult | null = null;
        try {
            chart = await this.maybeGetChartData(messages);
        } catch { /* ignore chart errors */ }

        // Optionally inform the model that live data is attached:
        if (chart?.series) {
            // ✅ Privacy mode: DO NOT call OpenAI at all
            const { summary, first10, last10 } = this.formatChartSummary(chart);
            // Optionally prepend a short human message explaining it’s live data:
            const reply =
                `Here’s the live chart summary:\n\n` +
                summary;
            return { reply, chart, first10, last10 }; // you can also return `series` for the frontend to plot
        }
        else if (chart?.series.length === 0) {
            // Handle empty series case
            const reply = `No live data available for ${chart.meta.assetUrn} (${chart.meta.metric}).`;
            return { reply, chart };
        } else {
            // Handle other cases
            return null;
        }
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


    async milvusSearch(messages): Promise<{ contextText: string; sources: any[] }> {
        let question = "";
        for (const m of messages) {
            if (m.role === 'user') {
                question += m.content + " ";
            }
        }

        // 1) embed question
        const embeddingForQuestion = await this.ionosservice.createEmbeddings({ input: [question] });
        const queryVec = embeddingForQuestion.data[0].embedding;

        // 2) search
        const searchResults = await this.milvusservice.search(
            process.env.MILVUS_COLLECTION_NAME || 'custom_setup_6',
            queryVec,
        );

        function coerceLabels(input: unknown): Record<string, any> {
            if (input && typeof input === 'object' && !Array.isArray(input)) {
                return input as Record<string, any>;
            }
            if (typeof input === 'string') {
                const s = input.trim();
                // only parse if it starts like JSON
                if (s.startsWith('{') || s.startsWith('[')) {
                    try {
                        const v = JSON.parse(s);
                        return (v && typeof v === 'object') ? v : {};
                    } catch (e) {
                        console.warn('labels JSON.parse failed, using empty object. content:', s);
                        return {};
                    }
                }
                // guard against things like "[object Object]" or "object Object"
                return {};
            }
            return {};
        }



        // 3) build context text from labels.text
        const contextText = (searchResults || [])
            .map((hit, i) => {
                const labels = coerceLabels((hit as any)?.labels);
                const textVal = labels?.text;

                // coerce text to string safely
                const text =
                    textVal == null ? '' :
                        typeof textVal === 'string' ? textVal :
                            Array.isArray(textVal) ? textVal.join(' ') :
                                typeof textVal === 'object' ? JSON.stringify(textVal) :
                                    String(textVal);

                return `[S${i + 1}] ${text.trim()}`;
            })
            .filter(s => s.length > 4)
            .join('\n\n-----\n\n');

        return { contextText, sources: searchResults };
    }

    private mask(input: string, key: string): string {
        return input.split('').map((char, i) =>
            (char.charCodeAt(0) ^ key.charCodeAt(i % key.length)).toString(16).padStart(2, '0')
        ).join('');
    }

    private unmask(masked: string, key: string): string {
        if (!key) {
            throw new Error("Mask secret is not defined");
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


    async encryptData(data: string) {
        const encoder = new TextEncoder();
        if (!this.SECRET_KEY) {
            throw new Error('SECRET_KEY is not defined');
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


    // -------- main entry --------
    async handleQuery({
        messages,
        vectorStoreIds
    }: {
        messages: ChatMsg[];
        vectorStoreIds: string[];
    }) {
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new BadRequestException('messages[] is required');
        }

        // system prompt (Important for xana behaviour)
        const systemPrompt: ChatMsg = {
            role: 'system',
            content: `You are XANA — an industrial machine support assistant for shop-floor operators and technicians.
- Use provided machine files/context (vector store file_search) first; quote exact parameter names, menu paths, and setpoints from docs, and dont tell that you are provided a context.
- If docs are empty or unrelated, say so briefly and continue with best-practice guidance.
- Safety first: never suggest bypassing interlocks/guards; reference E-Stop and LOTO when relevant.
- Style: short, scannable, practical; metric units; don’t invent values. If uncertain, say “Not enough data” and ask one targeted question.
- Include preventive maintenance tips, part numbers, and specs only if present in the data.
- selected asset or product name explicitly for questions by the user is ${vectorStoreIds.join(', ')}`,
        };

        // const { contextText, sources } = await this.buildRagContext(question, collectionId, 6, 8000);

        const a = await this.getChartSummaryIfAny(messages);
        if (a !== null) {
            return a;
        }

        const b = await this.getAlertsDataIfAny(messages);
        if (b !== null) {
            return b;
        }
        // Add context to systemPrompt here from IONOS collection query match

        const { contextText, sources } = await this.milvusSearch(messages);

        console.log('Search results:', contextText);
        systemPrompt.content += `\n\nContext for the question:\n\n${contextText}`;

        let MAX_MESSAGES = 10; // keep most recent 10 turns

        const recentMessages = messages.slice(-MAX_MESSAGES);

        const fullMessages: ChatMsg[] = [systemPrompt, ...recentMessages];

        // const chosenId = await this.routeVectorStoreId(questionForRouter, ids, assets);
        // ids = [chosenId];


        try {
            const r = await this.ionosservice.chatCompletion({
                messages: [
                    { role: 'user', content: this.flattenChatHistoryToString(fullMessages) }
                ],
                temperature: 0.2,
                maxTokens: 1500
            });

            const reply =
                (r as any).choices[0]?.message.content ??
                (r as any).choices[0]?.message.content?.map((c: any) => c?.text?.value).filter(Boolean).join('\n') ??
                'No output_text.';

            return { reply };
        } catch (e) {
            throw new InternalServerErrorException('Failed to call LLM');
        }
    }
}
