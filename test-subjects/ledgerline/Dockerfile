# One image recipe for every Node service in this repo. Build context is the repo root.
#   docker build -f ledgerline/Dockerfile --build-arg SERVICE=ledgerline/services/transfers .
FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production SERVICE_DIR=${SERVICE}
WORKDIR /app
COPY shared/package.json shared/package-lock.json ./shared/
RUN cd shared && npm ci --omit=dev
COPY shared/lib ./shared/lib
COPY ${SERVICE} ./${SERVICE}
USER node
CMD ["sh", "-c", "exec node ${SERVICE_DIR}/index.js"]
