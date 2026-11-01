# 构建上下文是仓库根目录。esbuild 把服务端和依赖打成单文件，运行镜像里只有 Node 和产物。
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
# 锁文件校验需要 apps/mobile/package.json，但 Expo 的依赖服务端用不到。
# 仓库默认的 nodeLinker: hoisted 会让 --filter 失效，把 React Native 全部下载一遍，这里必须换掉。
COPY apps/mobile/package.json apps/mobile/
RUN pnpm install --frozen-lockfile --filter @xiaodouya/server... --node-linker=isolated
COPY apps/server apps/server
COPY packages/shared packages/shared
# 运行脚本前的依赖检查认的是 hoisted，会发现不一致并重新安装全部依赖，然后报 Broken lockfile。
# 上面的 --frozen-lockfile 已经校验过了。
RUN pnpm --config.verify-deps-before-run=false --filter @xiaodouya/server build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/server/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.mjs"]
