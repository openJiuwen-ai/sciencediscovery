// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * `pnpm --filter @sciencediscovery/accounts schema`
 *
 * Brings a fresh PostgreSQL database (RDS Supabase or GaussDB) up to the current
 * schema. Running it twice is a no-op, which is what makes it safe in a deploy
 * pipeline. Against RDS Supabase, run it with a role that may create tables in
 * `public` (the instance's admin user), not with the PostgREST `anon` role.
 *
 * `... schema --print` writes the same statements as one script instead, for
 * pasting into the Supabase SQL Editor. Both paths read `schema.ts`, so what is
 * pasted and what a deploy applies cannot drift apart.
 */

import { loadConfig } from "../config.js";
import { Database } from "../db.js";
import { SCHEMA_COLUMN_COMMENTS, SCHEMA_HARDENING, SCHEMA_STATEMENTS, applySchema } from "../schema.js";

function printSql(): void {
  const statements = [...SCHEMA_STATEMENTS, ...SCHEMA_COLUMN_COMMENTS, ...SCHEMA_HARDENING];
  const header = [
    "-- ScienceDiscovery accounts schema.",
    "-- Every statement is idempotent, so this is safe to re-run.",
    "-- The final four revoke Supabase's anon/authenticated grants and assume those roles exist.",
  ];
  console.log([...header, "", ...statements.map((statement) => `${statement};`)].join("\n"));
}

if (process.argv.includes("--print")) {
  printSql();
} else {
  const config = loadConfig();
  const database = new Database(config.databaseUrl);
  try {
    await applySchema(database);
    console.log("schema applied");
  } finally {
    await database.close();
  }
}
