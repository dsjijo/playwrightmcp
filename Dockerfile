FROM mcr.microsoft.com/playwright/mcp

USER root
WORKDIR /srv

COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
RUN chown -R node:node /srv
RUN mkdir -p /app/.playwright-mcp && chown node:node /app/.playwright-mcp

USER node

ENV PORT=10000
EXPOSE 10000

ENTRYPOINT ["node", "/srv/server.js"]