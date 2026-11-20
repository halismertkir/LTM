# syntax=docker/dockerfile:1

# Override to pin a digest or use a mirror: --build-arg BASE_IMAGE=...
ARG BASE_IMAGE=node:22-bookworm-slim

# ---- build: compile the web app and the server bundle -----------------------
FROM ${BASE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @ltm/web build && pnpm --filter @ltm/server build
# Self-contained production tree for the server (its node_modules, dist, migrations).
RUN pnpm --filter @ltm/server deploy --prod --legacy /out

# ---- runtime ----------------------------------------------------------------
FROM ${BASE_IMAGE}
ENV NODE_ENV=production \
    LTM_HOST=0.0.0.0 \
    LTM_PORT=8080 \
    LTM_DATA_DIR=/data \
    LTM_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /out ./server
COPY --from=build /repo/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LTM_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/server
CMD ["node", "dist/main.js"]
