# Runs Site Snapper as an always-on server. Railway, Render and Fly.io all build
# this automatically. The base image is Microsoft's official Playwright image,
# which already contains Chrome and every library it needs, so nothing has to be
# downloaded or installed by hand. Its version must match "playwright" in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev
COPY . .

ENV HOST=0.0.0.0 \
    PORT=4321 \
    NO_OPEN=1 \
    CONCURRENCY=2
EXPOSE 4321
CMD ["node", "server.js"]
