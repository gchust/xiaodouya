# 构建上下文是仓库根目录。esbuild 把服务端和依赖打成单文件，运行镜像里只有 Node 和产物。
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
# Expo 的依赖服务端用不到；过滤安装可以省下几分钟和几个 GB。
COPY apps/mobile/package.json apps/mobile/
RUN pnpm install --frozen-lockfile --filter @xiaodouya/server...
COPY apps/server apps/server
COPY packages/shared packages/shared
RUN pnpm --filter @xiaodouya/server build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/server/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.mjs"]
