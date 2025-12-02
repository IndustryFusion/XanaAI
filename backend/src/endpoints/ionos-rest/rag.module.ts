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

// rag.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RagIngestService } from './rag-ingest.service';
import { MilvusRagService } from './milvus.service';
import { IonosService } from './ionos.service';
import { OllamaModule } from '../ollama-rest/ollama.module';
import { OpeaModule } from '../opea-rest/opea.module';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    OllamaModule,
    OpeaModule,
  ],
  providers: [
    RagIngestService,
    MilvusRagService,
    IonosService,
  ],
  exports: [
    RagIngestService,
    MilvusRagService,
    IonosService,
  ],
})
export class RagModule {}