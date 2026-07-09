# Standalone ceremony verify worker. Modeled on monitoring-v2's Dockerfile.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Integrity-pinned, reproducible install (snarkjs 0.7.5 + cabure-crypto 2.0.0).
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN adduser -D -u 1001 pp
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.mjs ./
RUN chown -R pp /app
USER pp
EXPOSE 8080
CMD ["node", "server.mjs"]
