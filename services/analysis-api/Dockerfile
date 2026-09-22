FROM node:24.12.0-alpine AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/analysis-api/package.json services/analysis-api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci

COPY apps/web apps/web
COPY services/analysis-api services/analysis-api
COPY packages/contracts packages/contracts
COPY packages/domain packages/domain
COPY packages/db packages/db

RUN npm run typecheck
RUN npm run build --workspace @vibe-invest/contracts
RUN npm run build --workspace @vibe-invest/domain
RUN npm run build --workspace @vibe-invest/db
RUN npm run build --workspace @vibe-invest/web
RUN npm run build --workspace @vibe-invest/analysis-api

FROM node:24.12.0-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/analysis-api/package.json services/analysis-api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci --omit=dev --workspace @vibe-invest/analysis-api

COPY --from=build /workspace/services/analysis-api/dist ./services/analysis-api/dist
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/packages/domain/dist ./packages/domain/dist
COPY --from=build /workspace/packages/db/dist ./packages/db/dist
COPY --from=build /workspace/apps/web/dist ./services/analysis-api/public

ENV HOST=0.0.0.0
ENV PORT=3000
ENV WEB_STATIC_DIR=/app/services/analysis-api/public
ENV FINANCIAL_DATA_URL=http://financial-data:8000

EXPOSE 3000

CMD ["node", "services/analysis-api/dist/server.js"]
