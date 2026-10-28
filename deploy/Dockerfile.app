# 后端服务镜像(admin/client/open/portal/worker 共用, 由 compose command 区分)
#
# 为什么集中成一个镜像: 五个服务共享同一套 workspace 包与同一份 pnpm 依赖树，
# 分开构建会各自重复安装一遍，且版本容易漂移。

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# better-sqlite3 需要本地编译(仅 tools 使用), slim 镜像不含工具链
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# 先只拷清单，利用层缓存: 依赖没变时不必重装。
# web/partner-web 的 package.json 也必须存在，否则 workspace 成员缺失会让
# --frozen-lockfile 安装失败。
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages ./packages
COPY apps ./apps
COPY sdks ./sdks
COPY web/package.json ./web/package.json
COPY partner-web/package.json ./partner-web/package.json
COPY tsconfig.json tsconfig.base.json ./

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=prod
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# 运行期需要 node_modules(含 workspace 软链)与各包 dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/sdks ./sdks

RUN mkdir -p /app/data/keys /app/data/exports && chown -R node:node /app/data
USER node

CMD ["node", "apps/admin-api/dist/main.js"]
