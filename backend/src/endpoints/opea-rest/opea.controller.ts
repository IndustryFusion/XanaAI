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

import { Controller, Post, Body, Logger } from '@nestjs/common';
import { OpeaService } from './opea.service';

@Controller('opea')
export class OpeaController {
    private readonly logger = new Logger(OpeaController.name);

    constructor(
        private readonly opeaService: OpeaService,
    ) {}

    @Post('chat')
    async chat(@Body() body: any) {
        this.logger.log('[OPEA] Chat endpoint called');
        return this.opeaService.chatCompletion({
            messages: body.messages,
            temperature: body.temperature,
            maxTokens: body.max_tokens,
            extra: body.extra,
        });
    }

    @Post('embeddings')
    async embeddings(@Body() body: any) {
        this.logger.log(`[OPEA] Embeddings endpoint called for ${Array.isArray(body.input) ? body.input.length : 1} inputs`);
        return this.opeaService.createEmbeddings({
            input: body.input,
            encodingFormat: body.encoding_format,
        });
    }

    @Post('rerank')
    async rerank(@Body() body: any) {
        this.logger.log(`[OPEA] Rerank endpoint called for query: "${body.query?.substring(0, 50)}..."`);
        return this.opeaService.rerank({
            query: body.query,
            documents: body.documents,
            topN: body.top_n,
            model: body.model,
        });
    }
}
