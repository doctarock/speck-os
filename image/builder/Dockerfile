# Build environment for the Speck OS image: a pinned mkosi plus the disk tools speck-install uses.
# Needs `docker run --privileged` (loop devices, mounts). image/build.sh runs it.
# qemu + OVMF are for the Secure Boot test (image/test-install.sh with BOOT_TEST=1).
FROM ubuntu:24.04
ARG MKOSI_REF=v25.3
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-venv git ca-certificates bubblewrap uidmap apt dpkg ubuntu-keyring systemd \
      zstd xz-utils tar cpio kmod util-linux fdisk gdisk parted dosfstools e2fsprogs btrfs-progs rsync udev \
      curl qemu-system-x86 ovmf \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/mkosi \
    && /opt/mkosi/bin/pip install --no-cache-dir "git+https://github.com/systemd/mkosi@${MKOSI_REF}"
ENV PATH=/opt/mkosi/bin:$PATH
