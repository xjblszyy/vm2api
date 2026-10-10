# KVM slot runner: one container per slot, cloud-hypervisor + virtiofsd inside.
# The guest rootfs is the kin-os image for the slot's OS, flattened to ext4.
#   docker build --build-arg OS_IMAGE=ghcr.io/dofastted/kin-os-debian:12 \
#     -t ghcr.io/dofastted/kin-vmm-debian:12 -f docker/kin-vmm/Dockerfile .
ARG OS_IMAGE=ghcr.io/dofastted/kin-os-debian:12

# cloud-hypervisor from the pinned release tag plus docker/kin-vmm/patches
# (per-slot SMBIOS BIOS identity). Static musl, like the upstream release binary.
FROM rust:1.91-bookworm AS chbuild
ARG CH_VERSION=v53.0
ARG CH_COMMIT=9ed824d6d08df3e96f7d5f50795d9449ac99f431
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/* \
 && rustup target add x86_64-unknown-linux-musl
RUN git clone --depth 1 --branch "${CH_VERSION}" https://github.com/cloud-hypervisor/cloud-hypervisor.git /ch \
 && test "$(git -C /ch rev-parse HEAD)" = "${CH_COMMIT}"
COPY docker/kin-vmm/patches/ /patches/
RUN cd /ch && for p in /patches/*.patch; do git apply "$p"; done \
 && cargo build --release --locked --target x86_64-unknown-linux-musl --bin cloud-hypervisor --bin ch-remote \
 && install -m 755 target/x86_64-unknown-linux-musl/release/cloud-hypervisor target/x86_64-unknown-linux-musl/release/ch-remote /usr/local/bin/

FROM golang:1.25-bookworm AS guestbin
WORKDIR /src
COPY worker/go.mod worker/go.sum ./
RUN go mod download
COPY worker/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/kin-guest ./cmd/kin-guest

FROM ${OS_IMAGE} AS osroot
USER root
COPY --from=guestbin /out/kin-guest /sbin/kin-guest
# iproute2 brings eth0 up in the guest. Container-image markers must not exist in a VM:
# the docker env file, a baked hostname/machine-id, and Fedora's "Container Image" variant.
RUN if command -v apt-get >/dev/null; then apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*; \
    elif command -v dnf >/dev/null; then dnf install -y iproute && dnf clean all; \
    elif command -v pacman >/dev/null; then pacman -Sy --noconfirm iproute2 && pacman -Scc --noconfirm; fi \
 && rm -f /.dockerenv /run/.containerenv /etc/hostname /etc/machine-id \
 && for f in /usr/lib/os-release /etc/os-release; do [ -f "$f" ] && [ ! -L "$f" ] && sed -i \
      -e 's/ (Container Image)//' -e 's/^VARIANT="Container Image"/VARIANT="Server Edition"/' \
      -e 's/^VARIANT_ID=container/VARIANT_ID=server/' "$f"; done; \
    mkdir -p /run/kin /home/kincli

FROM debian:13 AS rootfs
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs && rm -rf /var/lib/apt/lists/*
COPY --from=osroot / /rootfs/
RUN rm -f /rootfs/.dockerenv \
 && size=$(( $(du -sm /rootfs | cut -f1) * 13 / 10 + 256 )) \
 && mkfs.ext4 -q -L kinroot -d /rootfs /rootfs.ext4 "${size}M" \
 && sha256sum /rootfs.ext4 | cut -d" " -f1 > /rootfs.id

FROM debian:13
ARG KERNEL_RELEASE=ch-release-v7.2.8-20261009
ARG KERNEL_SHA256=edfeb8a8a6c04ff2979e9f1c700feaa29b8f564f952261834ef0b7d2e673a853
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl iproute2 iptables virtiofsd \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/kin-vmm \
 && curl -fsSL -o /opt/kin-vmm/vmlinux "https://github.com/cloud-hypervisor/linux/releases/download/${KERNEL_RELEASE}/vmlinux-x86_64" \
 && echo "${KERNEL_SHA256}  /opt/kin-vmm/vmlinux" | sha256sum -c -
COPY --from=chbuild /usr/local/bin/cloud-hypervisor /usr/local/bin/ch-remote /opt/kin-vmm/
COPY --from=guestbin /out/kin-guest /usr/local/bin/kin-guest
COPY --from=rootfs /rootfs.ext4 /rootfs.id /opt/kin-vmm/
COPY docker/kin-vmm/start.sh /usr/local/bin/kin-vmm
# Host kin-worker / kin-kernel are bind-mounted here when present; the dir must exist on a read-only root.
RUN chmod 755 /usr/local/bin/kin-vmm && mkdir -p /opt/kin/bin /var/lib/kin-vmm
LABEL kin.vmm=1
ENTRYPOINT ["/usr/local/bin/kin-vmm"]
