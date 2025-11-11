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

// ionos-ai.controller.ts
import { Controller, Post, Body } from '@nestjs/common';
import { IonosService } from './ionos.service';

type ChatRole = 'system' | 'user' | 'assistant' | 'tool' | 'function';
interface ChatMessage { role: ChatRole; content: string; }

class ChatDto {
  messages!: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  extra?: Record<string, any>;
}

class EmbeddingsDto {
  input!: string | string[];
  encodingFormat?: 'float' | 'base64';
}

@Controller('ai')
export class IonosController {
  constructor(private readonly ionos: IonosService) {}

  @Post('chat')
  async chat(@Body() dto: ChatDto) {
    return this.ionos.chatCompletion(dto);
  }

  @Post('embeddings')
  async embeddings(@Body() dto: EmbeddingsDto) {
    return this.ionos.createEmbeddings(dto);
  }
}