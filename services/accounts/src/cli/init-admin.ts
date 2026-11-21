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
 * Creates or resets the first admin account.
 *
 *   ADMIN_USERNAME=ops ADMIN_PASSWORD='...' pnpm --filter @sciencediscovery/accounts init-admin
 *
 * Re-running with the same username resets the password and unlocks the account.
 */

import { loadConfig } from "../config.js";
import { hashPassword } from "../crypto.js";
import { Database } from "../db.js";
import { applySchema } from "../schema.js";

const config = loadConfig();
const username = (process.env.ADMIN_USERNAME ?? "").trim() || "admin";
const password = (process.env.ADMIN_PASSWORD ?? "").trim();
const role = Number(process.env.ADMIN_ROLE ?? 2);

if (password.length < 12) {
  console.error("ADMIN_PASSWORD must be at least 12 characters");
  process.exit(1);
}

const database = new Database(config.databaseUrl);
try {
  await applySchema(database);
  const passwordHash = await hashPassword(password);
  await database.query(
    `INSERT INTO admin_users (username, password_hash, role, status)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, status = 0, failed_count = 0, locked_until = NULL`,
    [username, passwordHash, role],
  );
  console.log(`admin "${username}" is ready (role ${role})`);
} finally {
  await database.close();
}
