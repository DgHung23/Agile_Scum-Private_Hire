# PrivateHire Cars - single container: API + built web app
# docker compose --profile full up --build   ->  http://localhost:4000

FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
COPY --from=web /app/web/dist ./web/dist
WORKDIR /app/server
EXPOSE 4000
USER node
CMD ["node", "src/index.js"]
