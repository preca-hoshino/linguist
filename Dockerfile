# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1-bookworm AS rust-builder
ARG TARGETARCH
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends musl-tools binutils \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "${ARCH}" in \
      amd64) echo "x86_64-unknown-linux-musl" > /tmp/rust-target ;; \
      arm64) echo "aarch64-unknown-linux-musl" > /tmp/rust-target ;; \
      *) echo "Unsupported TARGETARCH: ${ARCH}" >&2; exit 1 ;; \
    esac \
    && rustup target add "$(cat /tmp/rust-target)"

COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

RUN TARGET="$(cat /tmp/rust-target)" \
    && export CC_x86_64_unknown_linux_musl=musl-gcc \
    && export CC_aarch64_unknown_linux_musl=musl-gcc \
    && export RUSTFLAGS="-C target-feature=+crt-static" \
    && cargo build --release --locked --bin linguist --target "${TARGET}" \
    && install -Dm755 "target/${TARGET}/release/linguist" /out/linguist \
    && (! readelf -l /out/linguist | grep -q 'INTERP') \
    && install -d -m 0755 -o 65532 -g 65532 /out/config

FROM scratch
LABEL org.opencontainers.image.title="Linguist" \
      org.opencontainers.image.description="Programmable script-routed OpenAI Chat API gateway and token telemetry dashboard" \
      org.opencontainers.image.source="https://github.com/preca-hoshino/linguist" \
      org.opencontainers.image.licenses="AGPL-3.0"

COPY --from=rust-builder /out/linguist /linguist
COPY --from=rust-builder --chown=65532:65532 /out/config /config

WORKDIR /config
USER 65532:65532
EXPOSE 9527

ENTRYPOINT ["/linguist"]
CMD ["serve"]
