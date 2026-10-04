# Build context is the repository root (see docker-compose.yml): the image needs database/migrations.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY tests/package.json tests/
RUN npm ci --workspace backend --include-workspace-root --ignore-scripts
COPY tsconfig.base.json ./
COPY backend backend
RUN npm run build --workspace backend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY tests/package.json tests/
# Production dependencies only. No dev tooling (nodemailer, pglite, vitest ...) ships in the image.
RUN npm ci --workspace backend --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY database database
# Attachment storage lives on a volume, outside the application directory.
RUN mkdir -p /data/attachments && chown -R node:node /data
USER node
ENV ATTACHMENT_DIR=/data/attachments APP_PORT=3000
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
