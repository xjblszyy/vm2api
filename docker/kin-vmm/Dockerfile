# KVM slot runner: one container per slot, cloud-hypervisor + virtiofsd inside.
# The guest rootfs is the kin-os image for the slot's OS, flattened to ext4.
#   docker build --build-arg OS_IMAGE=ghcr.io/dofastted/kin-os-debian:12 \
#     -t ghcr.io/dofastted/kin-vmm-debian:12 -f docker/kin-vmm/Dockerfile .
ARG OS_IMAGE=ghcr.io/dofastted/kin-os-debian:12

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
ARG CH_VERSION=v53.0
ARG CH_SHA256=448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc
ARG CH_REMOTE_SHA256=13f32ba952e6791fd901f2279be2055fbacc64005f96c42a8e90d58860df84a7
ARG KERNEL_RELEASE=ch-release-v7.2.8-20261009
ARG KERNEL_SHA256=edfeb8a8a6c04ff2979e9f1c700feaa29b8f564f952261834ef0b7d2e673a853
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl iproute2 iptables virtiofsd \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/kin-vmm \
 && curl -fsSL -o /opt/kin-vmm/cloud-hypervisor "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/${CH_VERSION}/cloud-hypervisor-static" \
 && echo "${CH_SHA256}  /opt/kin-vmm/cloud-hypervisor" | sha256sum -c - \
 && curl -fsSL -o /opt/kin-vmm/ch-remote "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/${CH_VERSION}/ch-remote-static" \
 && echo "${CH_REMOTE_SHA256}  /opt/kin-vmm/ch-remote" | sha256sum -c - \
 && curl -fsSL -o /opt/kin-vmm/vmlinux "https://github.com/cloud-hypervisor/linux/releases/download/${KERNEL_RELEASE}/vmlinux-x86_64" \
 && echo "${KERNEL_SHA256}  /opt/kin-vmm/vmlinux" | sha256sum -c - \
 && chmod 755 /opt/kin-vmm/cloud-hypervisor /opt/kin-vmm/ch-remote
COPY --from=guestbin /out/kin-guest /usr/local/bin/kin-guest
COPY --from=rootfs /rootfs.ext4 /rootfs.id /opt/kin-vmm/
COPY docker/kin-vmm/start.sh /usr/local/bin/kin-vmm
# Host kin-worker / kin-kernel are bind-mounted here when present; the dir must exist on a read-only root.
RUN chmod 755 /usr/local/bin/kin-vmm && mkdir -p /opt/kin/bin /var/lib/kin-vmm
LABEL kin.vmm=1
ENTRYPOINT ["/usr/local/bin/kin-vmm"]
