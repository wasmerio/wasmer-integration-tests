FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libssl3 libgcc-s1 libstdc++6 zlib1g libc6 socat \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --create-home edge
USER edge
WORKDIR /home/edge
