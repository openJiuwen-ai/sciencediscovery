# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# accounts 服务的独立镜像。构建上下文必须是仓库根目录：
#   docker build -f services/accounts/Dockerfile -t sciencediscovery/accounts:dev .
#
# 三个阶段：deps 只装生产依赖（pg），build 用 tsc 编译，runtime 以非 root 运行。
# 运行镜像里 admin/ 必须与 dist/ 平级：dist/app.js 用 `../admin` 定位管理台静态文件。

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- deps ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY services/accounts/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------- build ---
FROM ${NODE_IMAGE} AS build
WORKDIR /app/services/accounts
# tsconfig extends ../../tsconfig.base.json，按原目录层级摆放，避免改写配置。
COPY tsconfig.base.json /app/tsconfig.base.json
COPY services/accounts/package.json services/accounts/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY services/accounts/src ./src
RUN npm run build

# ---------------------------------------------------------------- runtime ---
FROM ${NODE_IMAGE} AS runtime

# HOST 必须显式设为 0.0.0.0：服务默认只监听回环地址，容器里绑定回环会让 ELB 摘掉实例。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4400

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY services/accounts/package.json ./package.json
COPY --from=build /app/services/accounts/dist ./dist
COPY services/accounts/admin ./admin

# node 镜像自带 uid/gid 1000 的 node 用户，直接沿用，不再新建。
USER node

EXPOSE 4400

# 用内置 fetch 探活，不额外装 curl/wget。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4400) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/server.js"]
