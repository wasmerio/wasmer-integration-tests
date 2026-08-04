FROM public.ecr.aws/docker/library/alpine:3.20 AS certs

FROM public.ecr.aws/docker/library/debian:bookworm-slim

# apt via https: CI egress is :443-only; slim ships no trust store
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN find /etc/apt -name '*.list' -o -name '*.sources' | xargs -r sed -i 's|http://|https://|g' \
  && apt-get -o Acquire::https::CAInfo=/etc/ssl/certs/ca-certificates.crt update \
  && apt-get -o Acquire::https::CAInfo=/etc/ssl/certs/ca-certificates.crt install -y --no-install-recommends ca-certificates libssl3 libgcc-s1 libstdc++6 zlib1g libc6 socat \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --create-home edge
USER edge
WORKDIR /home/edge
