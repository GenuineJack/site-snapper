# Runs Site Snapper as an always-on server with Chrome included.
# Works on Railway, Render, Fly.io, or anywhere that runs Docker.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci runs the postinstall script, which downloads the matching Chrome build;
# install-deps adds the Linux libraries Chrome needs.
RUN npm ci --omit=dev && npx playwright install-deps chromium && rm -rf /var/lib/apt/lists/*
COPY . .

ENV HOST=0.0.0.0 \
    PORT=4321 \
    NO_OPEN=1 \
    CONCURRENCY=2
EXPOSE 4321
CMD ["node", "server.js"]
