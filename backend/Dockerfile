FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /registry-api ./cmd/server

FROM alpine:3.22
RUN addgroup -S registry && adduser -S registry -G registry && apk add --no-cache ca-certificates tzdata
USER registry
COPY --from=build /registry-api /usr/local/bin/registry-api
EXPOSE 8080
ENTRYPOINT ["registry-api"]
