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

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { MongoClient } from 'mongodb';

@Injectable()
export class VectorMappingService {
  private client: MongoClient | null = null;

  private readonly uri = process.env.MONGODB_URI ?? '';

  private readonly dbName = process.env.MONGODB_DB ?? 'admin';
  private readonly colName = process.env.MONGODB_COL ?? 'vector_store_mappings';

  private async getClient(): Promise<MongoClient> {
    if (this.client) return this.client;

    this.client = new MongoClient(this.uri);
    await this.client.connect();

    // optional health check (no-op if server doesn’t support)
    try {
      await this.client.db(this.dbName).command({ ping: 1 });
    } catch {
      // ignore – still usable if connect() succeeded
    }

    return this.client;
  }

  async listMappings(): Promise<Array<{ id: string; asset_name?: string; vector_store_id: string }>> {
    try {
      const cli = await this.getClient();
      const col = cli.db(this.dbName).collection(this.colName);

      const docs = await col
        .find({}, { projection: { _id: 1, asset_name: 1, vector_store_id: 1 } })
        .sort({ asset_name: 1 })
        .limit(5000)
        .toArray();

      return docs.map((d: any) => ({
        id: String(d._id),
        asset_name: d.asset_name,
        vector_store_id: d.vector_store_id || '(unnamed asset)',
      }));
    } catch (e: any) {
      throw new InternalServerErrorException(e?.message || 'Mongo query failed');
    }
  }
}
