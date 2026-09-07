FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
COPY scripts/build-dashboard.mjs ./scripts/build-dashboard.mjs
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/graphify && /opt/graphify/bin/pip install --no-cache-dir graphifyy==0.9.55
ENV PATH="/opt/graphify/bin:${PATH}"
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db ./db
COPY dashboard ./dashboard
RUN mkdir -p /app/exports /workspace
EXPOSE 3338
CMD ["node", "dist/index.js"]
