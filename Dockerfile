FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# On-demand Zillow Research market-data ingestion. Not part of the web
# runtime image; built explicitly as a target for the market-ingest
# compose service and exits after one run.
FROM node:22-alpine AS ingest
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts ./scripts
USER node
CMD ["node", "scripts/ingest-zillow.mjs"]

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Docker sets HOSTNAME to the container name automatically, and the Next.js
# standalone server binds to $HOSTNAME if set. Without this override it would
# only bind that container-name address, never 127.0.0.1, breaking the
# Compose healthcheck below.
ENV HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
