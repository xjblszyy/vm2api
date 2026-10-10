# KVM 槽位

默认槽位是加固过的 Docker 容器，与宿主共用内核。KVM 槽位在同一个容器里再起一台 cloud-hypervisor 微虚拟机，槽内进程跑在独立内核上。

## 结构

```
宿主 Docker
└─ kin-<id>  (镜像 kin-vmm-<os>，网络仍是 kin-eg-<proxy>)
   ├─ virtiofsd ×3     /run/kin、/home/kincli、/opt/kin/bin 共享进客户机
   ├─ tap0 + MASQUERADE  只在槽容器自己的 netns 里
   ├─ kin-guest bridge   run/kernel.sock ⇄ vsock 1024
   └─ cloud-hypervisor
      └─ 客户机：kin-guest init (PID1) → kin-kernel → cli-node
```

- 槽容器名、网络、`/run/kin` 与 `/home/kincli` 的挂载都和 Docker 槽一样。控制面照旧拨 `vms/<id>/run/kernel.sock`，`docker start/stop/restart/rm` 不变。
- `docker exec` 会改写成 `docker exec kin-<id> kin-guest exec --vsock … -- <cmd>`，命令在客户机里执行（`src/lib/vm/kvm-runtime.mjs` 的 `kvmExecArgs`）。
- 出口和 Docker 槽一样走宿主 `kin-eg-*` 网桥：TCP 由 kin-egress 转进 SOCKS5，DNS 走 DoH，其它流量被网桥的 `FORWARD DROP` 丢掉。宿主侧不新增任何规则。
- 客户机根盘是 `kin-os-<os>` 镜像展平成的 ext4，每槽一份，存在 `vms/<id>/vmm/rootfs.ext4`，重启保留。镜像更新后（`rootfs.id` 变化）下次启动重新复制。
- `docker stop` 经 vsock 让客户机 PID1 同步并关机，约 2 秒，退出码 0。

## 身份

| 项 | 来源 |
|---|---|
| hostname、machine-id | `vm.fingerprint`，写进 `run/guest.json`，客户机 PID1 设置 |
| DMI 厂商 / 型号 / 序列号 / UUID、网卡 MAC | 由 `vm.id` + `guest_machine_id` 派生（`kvmHardwareIdentity`），重置指纹即轮换，不额外写 vm.json |
| `uname -r` | 客户机内核（cloud-hypervisor 官方 `vmlinux-x86_64`） |
| TZ、LANG | 与 Docker 槽相同 |

仍能看出是虚拟机的地方：CPUID 的 `hypervisor` 位（VPS 本身也有）、`bios_vendor=cloud-hypervisor`。客户机里没有 `/.dockerenv`，Fedora 的 os-release 不再带 "Container Image"。

## 要求

- 宿主有可读写的 `/dev/kvm`：裸机、开了嵌套虚拟化的 VPS，或装了 PVM 宿主内核的 VPS（见 TencentCloud/CubeSandbox 的 `deploy/pvm`，该场景未在本仓库验证）。控制面容器本身不需要 `/dev/kvm`（由宿主 Docker 打开）；宿主没有时 `docker run` 失败，返回 `kvm_unavailable`。
- 只支持 x86_64，且暂只支持控制面所在主机；集群节点上的 KVM 槽返回 `kvm_remote_unsupported`。
- 每槽内存：客户机 `KIN_KVM_MEMORY_MB`（默认 1024）+ 384 MB 余量作为容器上限。空闲时宿主实际占用约 340 MB（含 20 个 CLI 槽）。

## 创建与切换

创建槽位的面板 API（`POST /api/panel/vms/create`）传 `runtime_type: "kvm"`。控制台创建弹窗还没有这个选项，目前只能直接调 API。已有槽把 `vm.runtime.type` 改成 `kvm` 后重建即可：镜像不同，`startVmRuntime` 会替换容器；`cli-home` 和凭据不动。

镜像由 `guest-images` 工作流构建为 `ghcr.io/<owner>/kin-vmm-<os>`。本地构建：

```bash
docker build --build-arg OS_IMAGE=ghcr.io/dofastted/kin-os-debian:12 \
  -t ghcr.io/dofastted/kin-vmm-debian:12 -f docker/kin-vmm/Dockerfile .
```

## 暂不支持

- 官方 Claude Code 初始化（`official-cc-bootstrap`）：需要 PTY 和容器内存调整，返回 `kvm_official_cc_unsupported`。请用 OAuth 或导入凭据。
- 集群节点、ARM64 宿主。

## 排查

```bash
docker logs kin-<id>                                     # 运行器 + 客户机串口
docker exec kin-<id> kin-guest exec --vsock /run/kin-vmm/vsock.sock -- sh -c 'ps aux'
```

- 日志停在 `virtiofsd … exited`：槽容器缺 `SETPCAP`，或宿主内核不支持 virtiofs 所需的 fuse。
- 有 `kin-guest: ready` 但 `kernel.sock` 无响应：看客户机里 `kin-kernel exited` 的原因，通常是 `cli-home/.kin` 未落地。
