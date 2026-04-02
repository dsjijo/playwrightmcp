# Dockerfile
FROM mcr.microsoft.com/playwright/mcp

WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=10000
EXPOSE 10000

CMD ["node", "/srv/server.js"]