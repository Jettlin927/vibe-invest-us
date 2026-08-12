FROM node:24.12.0-alpine AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/analysis-api/package.json services/analysis-api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/product-dao/package.json packages/product-dao/package.json
RUN npm ci

COPY apps/web apps/web
COPY services/analysis-api services/analysis-api
COPY packages/contracts packages/contracts
COPY packages/product-dao packages/product-dao

RUN npm run typecheck
RUN npm run build --workspace @vibe-invest/contracts
RUN npm run build --workspace @vibe-invest/product-dao
RUN npm run build --workspace @vibe-invest/web
RUN npm run build --workspace @vibe-invest/analysis-api

FROM node:24.12.0-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/analysis-api/package.json services/analysis-api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/product-dao/package.json packages/product-dao/package.json
RUN npm ci --omit=dev --workspace @vibe-invest/analysis-api

COPY --from=build /workspace/services/analysis-api/dist ./services/analysis-api/dist
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /workspace/packages/product-dao/dist ./packages/product-dao/dist
COPY --from=build /workspace/apps/web/dist ./services/analysis-api/public

ENV HOST=0.0.0.0
ENV PORT=3000
ENV WEB_STATIC_DIR=/app/services/analysis-api/public
ENV DATABASE_PATH=/data/vibe-invest.db
ENV FINANCIAL_DATA_URL=http://financial-data:8000

EXPOSE 3000

CMD ["node", "services/analysis-api/dist/server.js"]
