# KVM 槽位

默认槽位是加固过的 Docker 容器，与宿主共用内核。KVM 槽位在同一个容器里再起一台 cloud-hypervisor 微虚拟机，槽内进程跑在独立内核上。

## 结构

```
宿主 Docker（本机或集群节点）
└─ kin-<id>  (镜像 kin-vmm-<os>；节点上是 kin-slot-vmm-<os>，网络仍是 kin-eg-<proxy>)
   ├─ virtiofsd ×3-4   /run/kin、/home/kincli、/opt/kin 共享进客户机；
   │                   节点槽单独绑的 ~/.claude 也单独共享
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
- `docker exec -it`（官方 Claude Code 常驻会话）在客户机里分配真实 PTY，窗口大小随 `SIGWINCH` 同步。

## 集群节点

节点上的 KVM 槽镜像在节点本机构建：`FROM kin-vmm-<os>`，槽内二进制烤进 `/opt/kin`（不放 `/usr/local/bin`，运行器经 virtiofs 交给客户机，客户机再链接回 `/usr/local/bin`）。出口助手 `kin-egress-*` 仍用普通槽镜像。控制面经 SSH 中继拨节点上的 `run/kernel.sock`，与容器槽相同。节点需要先拉取 `kin-vmm-<os>`。

## 身份

| 项 | 来源 |
|---|---|
| hostname、machine-id | `vm.fingerprint`，写进 `run/guest.json`，客户机 PID1 设置 |
| DMI 厂商 / 型号 / 序列号 / UUID、BIOS 厂商 / 版本 / 日期、网卡 MAC | 由 `vm.id` + `guest_machine_id` 派生（`kvmHardwareIdentity`），重置指纹即轮换，不额外写 vm.json |
| `uname -r` | 客户机内核（cloud-hypervisor 官方 `vmlinux-x86_64`） |
| TZ、LANG | 与 Docker 槽相同 |

cloud-hypervisor 由镜像从 v53.0 源码编译，打 `docker/kin-vmm/patches/` 的补丁：BIOS 厂商 / 版本 / 日期读 `KIN_SMBIOS_BIOS_*`，设了厂商就清掉 SMBIOS 的「是虚拟机」特征位。不设这些变量时与上游一致。

仍能看出是虚拟机的地方：CPUID 的 `hypervisor` 位（VPS 本身也有，去不掉）。客户机里没有 `/.dockerenv`，Fedora 的 os-release 不再带 "Container Image"。

## 要求

- 宿主有可读写的 `/dev/kvm`：裸机、开了嵌套虚拟化的 VPS，或装了 PVM 宿主内核的 VPS（见 TencentCloud/CubeSandbox 的 `deploy/pvm`，该场景未在本仓库验证）。控制面容器本身不需要 `/dev/kvm`（由宿主 Docker 打开）；宿主没有时 `docker run` 失败，返回 `kvm_unavailable`。
- 只支持 x86_64 宿主（本机与集群节点都一样）。槽内 kernel / CLI 只有 amd64，ARM 宿主上的虚拟机是 arm64 客户机，跑不了它们，返回 `kvm_arch_unsupported`。
- 创建前会问目标宿主的 Docker：能否给容器 `/dev/kvm`、镜像是否已拉取。结果缓存 10 分钟，`GET /api/panel/vms/kvm-capability?kernel=&node_id=` 可以单独查。
- 每槽内存：客户机 `KIN_KVM_MEMORY_MB`（默认 1024）+ 384 MB 余量作为容器上限。空闲时宿主实际占用约 340 MB（含 20 个 CLI 槽）。

## 创建与切换

控制台「新建虚拟机」的「隔离」选 **KVM 虚拟机**（只对 Claude 槽显示），弹窗会先检查目标宿主，不可用时说明原因并禁止提交。API 是 `POST /api/panel/vms/create` 传 `runtime_type: "kvm"`。已有槽把 `vm.runtime.type` 改成 `kvm` 后重建即可：镜像不同，`startVmRuntime` 会替换容器；`cli-home` 和凭据不动。

镜像由 `guest-images` 工作流构建为 `ghcr.io/<owner>/kin-vmm-<os>`。本地构建：

```bash
docker build --build-arg OS_IMAGE=ghcr.io/dofastted/kin-os-debian:12 \
  -t ghcr.io/dofastted/kin-vmm-debian:12 -f docker/kin-vmm/Dockerfile .
```

## 与容器槽的差异

- 客户机内存在开机时固定（`KIN_KVM_MEMORY_MB`）。官方 Claude Code 初始化原本会临时调高容器内存，KVM 槽跳过这一步。
- ARM64 宿主不支持，见上。
- 只有 Claude 槽能选 KVM。GPT（Codex）槽的推理内核 `kin-codex-kernel` 由控制面在宿主上直接运行，流量不经过槽容器，套虚拟机隔离不到它。

## 排查

```bash
docker logs kin-<id>                                     # 运行器 + 客户机串口
docker exec kin-<id> kin-guest exec --vsock /run/kin-vmm/vsock.sock -- sh -c 'ps aux'
```

- 日志停在 `virtiofsd … exited`：槽容器缺 `SETPCAP`，或宿主内核不支持 virtiofs 所需的 fuse。
- 有 `kin-guest: ready` 但 `kernel.sock` 无响应：看客户机里 `kin-kernel exited` 的原因，通常是 `cli-home/.kin` 未落地。
