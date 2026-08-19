# syntax=docker/dockerfile:1.7
FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @surfgate/relay deploy --legacy --prod /release

FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS runtime
ENV NODE_ENV=production
ENV SURFGATE_RELAY_HOST=0.0.0.0
ENV SURFGATE_RELAY_PORT=8081
WORKDIR /app
RUN groupadd --system --gid 10001 surfgate \
  && useradd --system --uid 10001 --gid surfgate --home-dir /nonexistent --shell /usr/sbin/nologin surfgate
COPY --from=build --chown=surfgate:surfgate /release/ ./
USER 10001:10001
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.SURFGATE_RELAY_PORT+'/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
