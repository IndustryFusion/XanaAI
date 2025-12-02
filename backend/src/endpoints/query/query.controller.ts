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

import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { QueryService } from './query.service';
import { QueryDto } from './dto/query.dto';
import * as findAuthDto from './dto/find-auth.dto';

@Controller('query')
export class QueryController {
  constructor(private readonly queryService: QueryService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handleQuery(@Body() dto: QueryDto) {
    // Ensure vectorStoreIds is always an array of strings
    const { messages, vectorStoreIds, hostProvider, assets } = dto;
    const normalizedVectorStoreIds: string[] =
      typeof vectorStoreIds === 'string'
        ? [vectorStoreIds]
        : Array.isArray(vectorStoreIds)
        ? vectorStoreIds
        : [];

    // Extract asset names from AssetDto array
    const assetNames: string[] = assets?.map(asset => asset.asset_name).filter((name): name is string => Boolean(name)) || [];

    return this.queryService.handleQuery({
      hostProvider,
      messages,
      vectorStoreIds: normalizedVectorStoreIds,
      assets: assetNames,
    });
  }

  @Post('get-indexed-db-data')
  getIndexedData(@Body() data: findAuthDto.FindIndexedDbAuthDto) {
    try {
      return this.queryService.getIndexedData(data);
    } catch (err) {
      throw err;
    }
  }
}