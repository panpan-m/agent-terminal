# Linux 内核调试题集（Raspberry Pi 5 / Debian 13）

面向串口网关 + MCP agent 的实测题集。所有“证据”都来自本机真实输出：

- 板子：Raspberry Pi 5 Model B Rev 1.0
- 系统：Debian GNU/Linux 13 (trixie)
- 内核：`6.18.39+rpt-rpi-2712`，`SMP PREEMPT`，`CONFIG_HZ=250`
- 控制台：`ttyAMA10`（PL011），115200 8N1

每题包含：**给 agent 的题面**、调查命令、实测证据、参考答案、风险。
除特别标注外均为只读命令；写操作（改 governor、ftrace、改 cmdline）都标了风险。

---

## Q1 内存 cgroup 控制器为什么消失了？（基础）

**题面**

> 这台机器上 systemd 无法设置 `MemoryMax`，容器也不能限制内存。请确认 memory cgroup 控制器是否可用，找出原因，并给出恢复步骤。

**调查**

```bash
cat /sys/fs/cgroup/cgroup.controllers
grep -E 'memory|pids|cpu ' /proc/cgroups
tr ' ' '\n' < /proc/cmdline | grep -i cgroup
grep -i cgroup /var/log/dmesg 2>/dev/null | tail
```

**实测证据**

```text
controllers: cpuset cpu io pids
cgroups:     pids  0  83  1
cmdline:     cgroup_disable=memory
```

**参考答案**

内存控制器被**启动参数** `cgroup_disable=memory` 关闭，不是内核没编译。
cgroup v2 的 `memory` 不在 `cgroup.controllers` 里，所以 systemd/容器设置内存上限会失败。

恢复：编辑启动 cmdline（本机是 `/boot/firmware/cmdline.txt`），删除 `cgroup_disable=memory`，重启后验证：

```bash
grep memory /sys/fs/cgroup/cgroup.controllers   # 应出现 memory
```

**风险**：改 cmdline + 重启会中断会话；只读调查不需要重启。

---

## Q2 配置里有 CONFIG_PSI=y，为什么没有 /proc/pressure？（基础+）

**题面**

> 想用 PSI 观察 CPU/IO 压力，但 `/proc/pressure` 不存在。内核配置里明明有 `CONFIG_PSI=y`，请解释原因并给出启用方法。

**调查**

```bash
ls /proc/pressure
grep -E 'CONFIG_PSI' /boot/config-$(uname -r)
cat /proc/cmdline
```

**实测证据**

```text
ls: cannot access '/proc/pressure': No such file or directory
CONFIG_PSI=y
CONFIG_PSI_DEFAULT_DISABLED=y
```

**参考答案**

PSI 编译进内核了，但被 **`CONFIG_PSI_DEFAULT_DISABLED=y`** 设为默认关闭。启动参数加 `psi=1` 后重启，才会出现：

```text
/proc/pressure/cpu
/proc/pressure/io
/proc/pressure/memory
```

这是“配置存在 ≠ 运行时启用”的典型题：要同时看 config 和 cmdline。

**风险**：改 cmdline + 重启。

---

## Q3 CPU 最高 2.4 GHz，为什么一直跑 1.5 GHz？（基础）

**题面**

> 这台 Pi 5 的 CPU 最大频率是 2.4 GHz，但 `scaling_cur_freq` 一直是 1.5 GHz。判断是限频、降频还是正常调频，并给出验证方法。

**调查**

```bash
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq
vcgencmd get_config arm_freq
vcgencmd measure_clock arm
vcgencmd measure_temp
vcgencmd get_throttled
uptime
```

**实测证据**

```text
governor=ondemand
scaling_max_freq=2400000  cpuinfo_max_freq=2400000
arm_freq=2400  frequency(0)=1500016128
temp=46.6'C  throttled=0x0
```

**参考答案**

空闲时 `ondemand` 把频率降到 1.5 GHz 是正常的，最大频率并未被限制。
判断是否异常要看：

- `get_throttled`：`0x0` 表示本次启动没有欠压/降频事件；非 0 时按位解释（bit0 欠压、bit1 频率上限、bit2 当前降频、bit16+ 历史）。
- 温度与供电：`measure_temp`、换官方电源。
- 想看满频：临时 `echo performance > .../scaling_governor` 并加负载；测完恢复 `ondemand`。

**风险**：改 governor 属于写 sysfs；只读题面不需要。

---

## Q4 brcmfmac 的 txcap/p2p 警告严重吗？（中级）

**题面**

> dmesg 里有 brcmfmac 的 `no txcap_blob available (err=-2)` 和 `brcmf_p2p_send_action_frame: Unknown Frame: category 0xa, action 0x8`。判断这些是内核 bug、驱动 bug 还是无害固件噪音，并说明是否需要处理。

**调查**

```bash
dmesg -T | grep -i brcmfmac | tail -20
cat /sys/module/brcmfmac/version 2>/dev/null
ip -s link show wlan0
iw dev wlan0 link 2>/dev/null
```

**实测证据**

```text
brcmfmac: brcmf_c_process_txcap_blob: no txcap_blob available (err=-2)
brcmfmac: ... Firmware: BCM4345/6 wl0: Aug 29 2023 ... version 7.45.265
brcmfmac: brcmf_cfg80211_set_power_mgmt: power save enabled
wlan0: RX packets 21758, errors 0, dropped 2
```

**参考答案**

- `txcap_blob` 是可选的发射校准数据，固件没提供时返回 `-ENOENT`，属正常提示，不是失败。
- P2P `Unknown Frame` 是固件收到不认识的 Wi-Fi Direct action frame（category 0xa/action 0x8）后的日志；偶发时是无害的邻近设备流量。
- 判断标准：`ip -s link` 的 errors/dropped 是否持续增长、Wi-Fi 是否断流。当前 `errors=0, dropped=2/21758`，可忽略；持续增长再查固件/驱动或关闭 P2P。

**风险**：只读。

---

## Q5 硬件看门狗 vs softlockup 检测（中级）

**题面**

> systemd 日志说 “Watchdog running with a hardware timeout of 1min”，但 `/proc/sys/kernel/watchdog` 不存在。这台机器到底有没有 softlockup/hardlockup 检测？硬件看门狗和它们有什么区别？

**调查**

```bash
ls /sys/class/watchdog
cat /sys/class/watchdog/watchdog0/identity
cat /sys/class/watchdog/watchdog0/timeout
cat /sys/class/watchdog/watchdog0/state
grep -E 'CONFIG_SOFTLOCKUP|CONFIG_HARDLOCKUP|CONFIG_LOCKUP' /boot/config-$(uname -r)
dmesg | grep -i watchdog | tail
systemctl show -p RuntimeWatchdogUSec
```

**实测证据**

```text
watchdog0 / timeout=60
bcm2835-wdt: Broadcom BCM2835 watchdog timer
systemd: Using hardware watchdog ... timeout of 1min
# CONFIG_SOFTLOCKUP_DETECTOR is not set
# CONFIG_HARDLOCKUP_DETECTOR is not set
/proc/sys/kernel/watchdog: No such file or directory
```

**参考答案**

- 有**硬件看门狗**：`bcm2835-wdt`，60 s，systemd 定期喂狗；systemd 卡死会触发硬复位。
- **没有** softlockup/hardlockup detector（两个配置都未设置），所以没有 `/proc/sys/kernel/watchdog`，也不会在 dmesg 里看到 “soft lockup” 报告。
- 两者不是一回事：硬件看门狗只保证“系统还能被喂狗”，不提供调用栈；lockup detector 才有 stall 检测和栈。

**风险**：只读；不要用 `echo c > /proc/sysrq-trigger` 测试。

---

## Q6 4 核的 Pi 为什么有 8 个 NUMA 节点？（中级+）

**题面**

> `/sys/devices/system/node/online` 显示 `0-7`，但这是一颗 4 核的 Pi 5。解释这些 NUMA 节点的来源、对调度/内存分配的影响，以及如何恢复成单节点。

**调查**

```bash
cat /sys/devices/system/node/online
cat /sys/devices/system/node/possible
tr ' ' '\n' < /proc/cmdline | grep -i numa
numactl -H 2>/dev/null
cat /sys/devices/system/node/node0/meminfo | head -4
```

**实测证据**

```text
online: 0-7   possible: 0-7
cmdline: numa_policy=interleave numa=fake=8
```

**参考答案**

不是物理 NUMA，是启动参数 **`numa=fake=8`** 把内存人为切成 8 个 fake node（配合 `numa_policy=interleave`），常用于 NUMA 相关测试/演示。
影响：NUMA-aware 分配、`numactl`、部分调度策略会看到 8 个节点；对普通负载没有收益。

恢复单节点：从 cmdline 删除 `numa=fake=8`（以及按需删除 `numa_policy=interleave`），重启后 `online` 应为 `0`。

**风险**：改 cmdline + 重启。

---

## Q7 SD 卡 I/O 配置与实测吞吐（中级）

**题面**

> 评估 `mmcblk0` 的 I/O 配置是否合理：调度器、预读、链路速度；实测顺序读吞吐并解释结果。

**调查**

```bash
cat /sys/block/mmcblk0/queue/scheduler
cat /sys/block/mmcblk0/queue/read_ahead_kb
cat /sys/block/mmcblk0/queue/rotational
dmesg | grep -i mmc0 | tail -8
dd if=/dev/mmcblk0 of=/dev/null bs=1M count=256 iflag=direct
```

**实测证据**

```text
scheduler: none [mq-deadline] kyber bfq
read_ahead_kb=128   rotational=0
mmc0: new UHS-I speed SDR104 SDXC card
mmcblk0: 119 GiB (quirks 0x00004000)
256 MiB copied, 3.03 s, 88.6 MB/s
```

**参考答案**

- SD 卡是 `rotational=0`，`mq-deadline` 对块设备是合理默认；`bfq` 对 SD 通常无益。
- SDR104 理论 ~104 MB/s，实测 88.6 MB/s 属正常范围（读缓存/卡质量会影响）。
- `read_ahead_kb=128` 是通用默认；纯顺序大文件可尝试 512–2048 并复测，随机小 I/O 不要盲目加大。
- `quirks 0x4000` 是 SDHCI 的控制器兼容标志，不要手改。

**风险**：`dd` 只读原始块设备，安全；不要写 `of=/dev/mmcblk0`。

---

## Q8 用 ftrace 跟踪一次 uname 的系统调用（进阶，需写 tracefs）

**题面**

> 使用 ftrace 的 function_graph 跟踪一次 `uname` 系统调用，给出调用路径，并正确清理 tracing 状态。

**调查/操作**

```bash
cd /sys/kernel/tracing
grep -i newuname available_filter_functions | head
cat available_tracers
echo 0 > tracing_on
echo function_graph > current_tracer
echo __arm64_sys_newuname > set_graph_function
echo > trace
echo 1 > tracing_on
uname >/dev/null
echo 0 > tracing_on
cat trace | head -40
# 清理
echo nop > current_tracer
echo > set_graph_function
echo > trace
```

**实测证据**

```text
available_filter_functions: __arm64_sys_newuname
available_tracers: blk function_graph wakeup_dl wakeup_rt wakeup function nop
tracefs on /sys/kernel/tracing type tracefs
```

**参考答案**

`function_graph` + `set_graph_function=__arm64_sys_newuname` 只跟踪该 syscall 的调用图。
`newuname` 的路径通常很浅（取 `uts_sem`、拷贝 `new_utsname`），trace 里主要看
`__arm64_sys_newuname` 这一棵调用树的缩进与耗时，而不是期待很长的调用链。
关键点：先 `tracing_on=0` 再换 tracer、清理时恢复 `nop` 并清空 `trace`，避免影响后续测量。

**风险**：写 tracefs；不影响业务，但必须清理。

---

## Q9 开放题：有 ttyS0 中断，却没有 /dev/ttyS0（考调查方法）

**题面**

> `/proc/interrupts` 里有一行 `ttyS0`（IRQ 33，计数约 2881），dmesg 也显示 `ttyS0 at MMIO 0x107d50c000 ... Broadcom BCM7271 UART`；但 `/dev/ttyS0` 和 `/sys/class/tty/ttyS0` 都不存在，控制台是 `ttyAMA10`。请列出可能原因，并设计最少 3 个只读实验来缩小范围。

**已知线索**

```text
/proc/consoles: tty1, ttyAMA10
cmdline: 8250.nr_uarts=1
dmesg: 8250/16550 driver, 1 ports; ttyS0 at MMIO ...; 107d001000.serial: ttyAMA10 ... is a PL011
ls /sys/class/tty | grep ttyS  -> 无
```

**期望答案（开放）**

不需要唯一结论，重点看调查路径，例如：

- 8250 端口是否注册了 tty 设备（`/sys/class/tty`、`/proc/tty/drivers`）；
- IRQ 33 的 action 名称与 debugfs `/sys/kernel/debug/irq/irqs/33`；
- 该 UART 是否被固件/蓝牙/其他驱动占用（dmesg 中 probe/unregister 记录）；
- 是否为“仅注册 IRQ、未注册 tty”的 console 端口，或被 `8250.nr_uarts` 限制后残留。

这题用来评估 agent 是否会先收集证据、提出假设，而不是直接编一个根因。

---

## 怎么用这套题测试 agent

推荐给 agent 的通用前缀：

```text
你可以通过串口 MCP 操作一台 Raspberry Pi 5（Debian 13，内核 6.18.39）。
可用工具：serial_sessions、serial_status、serial_read、serial_tail、
serial_write、serial_break、serial_command、serial_expect。
规则：
1. 先只读诊断，不要改配置/重启；
2. 每个结论都要引用命令的真实输出；
3. 输出顺序：现象确认 → 证据 → 根因 → 修复建议 → 验证方法；
4. 改配置类操作只给步骤，不实际执行。
题目：<上面的题面>
```

常用调用：

```json
{"lines": 40}                       // serial_tail：先看屏幕最后 40 行
{"command": "cat /proc/cmdline"}     // serial_command：执行诊断
{"command": "dd ...", "capture_exit": true, "timeout_ms": 30000}
```

评分建议：

| 维度 | 期望 |
|---|---|
| 证据 | 引用 `/proc`、`/sys`、`dmesg` 的真实输出，而不是泛泛而谈 |
| 区分层次 | 配置 vs 启动参数 vs 运行时状态（Q2 是典型） |
| 风险意识 | 不改 cmdline、不重启、不写块设备 |
| 结论 | 能区分“内核 bug / 驱动/固件提示 / 配置导致” |
| 修复 | 给出可验证的恢复步骤与验证命令 |
