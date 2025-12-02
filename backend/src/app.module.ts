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

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { QueryController } from './endpoints/query/query.controller';
import { QueryService } from './endpoints/query/query.service';
import { VectorMappingController } from './endpoints/vector_mapping/vector-mapping.controller';
import { VectorMappingService } from './endpoints/vector_mapping/vector-mapping.service';
import { IonosController } from './endpoints/ionos-rest/ionos.controller';
import { IonosService } from './endpoints/ionos-rest/ionos.service';
import { HttpModule } from '@nestjs/axios';
import { RagModule } from './endpoints/ionos-rest/rag.module';
import { OllamaModule } from './endpoints/ollama-rest/ollama.module';
import { OpeaModule } from './endpoints/opea-rest/opea.module';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    RagModule,
    OllamaModule,
    OpeaModule,
  ],
  controllers: [AppController, QueryController, VectorMappingController, IonosController],
  providers: [AppService, QueryService, VectorMappingService, IonosService],
})
export class AppModule {}
