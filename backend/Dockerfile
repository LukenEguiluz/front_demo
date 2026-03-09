# Backend API maletas (Node + SQLite)
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js init-db.js ./
RUN node init-db.js || true

ENV PORT=4001
EXPOSE 4001

CMD ["node", "server.js"]
