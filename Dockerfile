FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node . .

RUN npm ci --omit=optional --omit=dev \
  && git init \
  && git config user.name "AngChat Demo" \
  && git config user.email "demo@localhost" \
  && git add . \
  && git commit -m "Initialize cloud demo workspace"

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    CHAT_DB_PATH=/data/chat.db \
    CHAT_WORKSPACE=/app \
    CHAT_SKILLS_DIR=/data/skills \
    TRUST_PROXY=1 \
    CHAT_CAPTURE_TRACES=0

WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/skills \
  && chown -R node:node /data
COPY --chown=root:root entrypoint.sh /usr/local/bin/angchat-entrypoint
RUN chmod 755 /usr/local/bin/angchat-entrypoint
USER root
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/angchat-entrypoint"]
CMD ["node", "backend/index.js"]
