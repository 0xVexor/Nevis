# docker build -f deploy/Dockerfile -t nevis .       (from the repository root)
FROM node:24-bookworm AS web
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter web build

FROM golang:1.26 AS server
WORKDIR /src/server
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /nevis-server ./cmd/nevis-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /nevis-server /nevis-server
COPY --from=web /src/apps/web/dist /web
ENV WEB_DIR=/web DATA_DIR=/data LISTEN_HOST=0.0.0.0 PORT=8787
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["/nevis-server"]
