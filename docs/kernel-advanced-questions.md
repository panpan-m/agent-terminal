# 复杂 Linux 内核调试题集（Raspberry Pi 5 / 6.18）

面向已经做过基础题（`/proc`、`/sys`、`dmesg`）的进阶练习。每题的“可行性”都先在本机确认过：

| 设施 | 本机状态 |
|---|---|
| ftrace / tracefs | 可用（`function_graph`、`function`、`blk`、`wakeup_rt`…） |
| block tracepoints | 可用（`block_rq_issue` / `block_rq_complete` / `block_rq_merge`） |
| fio | `fio-3.39`，可做受控 I/O |
| gcc / make / 内核头文件 | 可用（`/usr/src/linux-headers-6.18.39+rpt-rpi-2712`） |
| hung task detector | `CONFIG_DETECT_HUNG_TASK=y`，timeout 120s，`hung_task_panic=0` |
| `sched_debug` / `schedstats` | 可读（`/sys/kernel/debug/sched/debug`，`CONFIG_SCHEDSTATS=y`） |
| pstore | `CONFIG_PSTORE_RAM=y`，但没有 ramoops 预留内存/后端，`/sys/fs/pstore` 为空 |
| kdump / vmcore | 无 `CRASH_DUMP`，没有 `/proc/vmcore` |
| lockdep | `CONFIG_PROVE_LOCKING` 未设置（只有 `LOCKDEP_SUPPORT`） |
| KASAN / KCSAN / DEBUG_ATOMIC_SLEEP | 未设置 |
| perf / bpftrace / bpftool / trace-cmd / blktrace | 未安装 |

结论：**深 ftrace、块 I/O、hung task、WARN 栈、热降频、软中断**这些可以真做；
**UAF/死锁/数据竞争**这类需要 KASAN/lockdep/KCSAN 的题，在这颗 Debian 内核上做不了，
更适合作为“需要什么调试内核”的设计题。

---

## A1 为什么一次 `cat` 产生 1275 行 `do_sys_openat2` 调用图？（中级+，安全）

**题面**

> 用 `function_graph` 跟踪 `cat /etc/hostname` 的 `do_sys_openat2`，得到 1275 行 trace、总耗时 39.685 µs。
> 解释为什么一次 `cat` 会触发这么多 open，如何把“目标文件的 open”从动态库加载中分离出来。

**为什么复杂**

- `cat` 是动态链接的：`ld.so` 会先打开 `/etc/ld.so.cache`、libc、locale 等，**每个都是 `openat`**，都在同一个 PID 里，`set_ftrace_pid` 挡不住。
- 外层 shell 的 `>/dev/null` 重定向发生在写入 `set_ftrace_pid` 之前，会混入少量其它进程的记录。
- `function_graph` 只显示函数名，不显示路径参数；要归因到 `/etc/hostname` 必须借助 tracepoint 或时间顺序。

**实测命令（单行，便于串口执行）**

```bash
cd /sys/kernel/tracing; echo 0 > tracing_on; echo nop > current_tracer; echo > trace; \
echo do_sys_openat2 > set_graph_function; echo function_graph > current_tracer; echo 1 > tracing_on; \
sh -c 'echo $$ > /sys/kernel/tracing/set_ftrace_pid; exec cat /etc/hostname' >/dev/null; \
echo 0 > tracing_on; grep -v '^#' trace > /tmp/openat.trace; \
echo nop > current_tracer; echo > set_graph_function; echo > set_ftrace_pid; echo > trace; \
wc -l /tmp/openat.trace; tail -3 /tmp/openat.trace
```

**实测结果**

```text
1275 /tmp/openat.trace
 2) + 39.685 us   |  do_sys_openat2() { ... }
```

关键片段：

```text
 2)               |  do_sys_openat2() {
 2)               |    getname_flags() { ... }
 2)               |    get_unused_fd_flags() { ... }
 2)               |    do_filp_open() {
 2)               |      path_openat() {
 2)               |        link_path_walk() { ... 9.222 us }
 2)               |        may_open() {
 2)               |          inode_permission() {
 2)               |            devcgroup_check_permission() {
 2)               |              __cgroup_bpf_check_dev_permission() { ... }
 2)   7.574 us    |          }
 2)   8.463 us    |        }
 2)               |        vfs_open() { ... }
 2) + 10.018 us   |      }
 2)               |      terminate_walk() { ... }
 2) + 39.685 us   |  }
```

**参考答案 / 判据**

- 1275 行不是“一次 open 的调用树”，而是 **cat 进程从 exec 到读文件期间的所有 open**：动态链接器加载库、locale，最后才是 `/etc/hostname`。
- 目标 open 是 **最后一个、耗时 39.685 µs** 的 `do_sys_openat2`；前面的短调用是库文件。
- 归因方法：
  1. 用 `sys_enter_openat` tracepoint（带 `filename`）与 function_graph 时间戳对齐；
  2. 或用 `strace -f -e trace=openat cat /etc/hostname` 先拿到文件名顺序，再回到内核调用图；
  3. 或把目标操作改成“已 exec 后只做一次 open”的程序（如静态小程序），减少 ld.so 噪声。
- 热点：`may_open()` 里的 `devcgroup_check_permission()` → `__cgroup_bpf_check_dev_permission()`（cgroup device BPF 检查）约 7.5 µs，比路径查找还显眼；这是容器/设备过滤路径，值得单独展开。

**风险**：只读；tracefs 写操作，已清理。

---

## A2 块 I/O 尾延迟：issue → complete 的 p95/p99（高级，安全）

**题面**

> 用 fio 在 SD 卡上做 4K 随机读和 1M 顺序读，同时用 block tracepoints 记录请求生命周期；
> 计算 issue→complete 的延迟分布（p50/p95/p99），解释尾延迟来自队列、合并还是设备。

**为什么复杂**

- 需要同时理解 fio 参数（`iodepth`、`direct`、`ioengine`）、block tracepoint 字段（`sector`、`nr_sector`、`rwbs`、`comm`）和请求合并。
- `block_rq_issue` 与 `block_rq_complete` 需要按 `(dev, sector)` 配对；有合并/拆分时不能简单按顺序配。
- 还要区分“块层队列延迟”和“设备完成延迟”。

**可行性**：fio 3.39 + block tracepoints 已确认；建议写到 `/tmp/fio.dat`，避免碰 SD 卡裸设备。

**操作骨架**

```bash
# 1) 建测试文件（受控，60s 内）
fio --name=seq --filename=/tmp/fio.dat --size=128M --bs=1M --rw=read --direct=1 \
    --ioengine=libaio --iodepth=4 --runtime=10 --time_based --output=/tmp/fio-seq.json --output-format=json

# 2) 开 block tracepoints
cd /sys/kernel/tracing
echo 0 > tracing_on
echo > trace
echo 1 > events/block/enable
echo 1 > tracing_on
fio --name=rand --filename=/tmp/fio.dat --size=64M --bs=4k --rw=randread --direct=1 \
    --ioengine=libaio --iodepth=1 --runtime=5 --time_based >/dev/null
echo 0 > tracing_on
grep -E 'block_rq_(issue|complete)' trace > /tmp/blk.trace
echo 0 > events/block/enable
```

**期望答案 / 判据**

- 先用 `iodepth=1` 简化配对；再用 `iodepth=4` 观察队列深度对 p99 的影响。
- 4K 随机读的 p99 应明显高于 1M 顺序读；若尾延迟集中在 `issue→complete` 而 `queue→issue` 很短，瓶颈在设备/卡；反之在块层排队。
- 合并（`block_rq_merge`）多说明顺序性好；随机读合并少。
- SD 卡无原生 NCQ，深队列收益有限，`mq-deadline` 的排队延迟会上升。

**风险**：写 `/tmp` 受控文件；不要对 `/dev/mmcblk0` 直接 fio 写。

---

## A3 hung task detector：构造一个 130 秒 D 状态线程（高级，中风险）

**题面**

> 写一个最小内核模块，创建一个 kthread 并让它进入不可中断睡眠 130 秒；
> 利用 `CONFIG_DETECT_HUNG_TASK` 观察 120 秒后的 hung task 报告，解释栈和 taint，然后清理模块。

**为什么复杂**

- 需要写/编译/加载模块，理解 `TASK_UNINTERRUPTIBLE`、`schedule_timeout_uninterruptible()`、hung task 检测阈值。
- 报告会包含所有 D 状态任务的栈，需要区分目标线程和其它正常 D 状态任务。
- 模块会 taint 内核；`hung_task_panic=0` 时只告警不 panic。

**可行性**：gcc/make/headers 都在；`/proc/sys/kernel/hung_task_timeout_secs=120`。

**模块核心**

```c
#include <linux/module.h>
#include <linux/kthread.h>
#include <linux/delay.h>

static struct task_struct *thr;
static int run(void *unused)
{
    schedule_timeout_uninterruptible(130 * HZ);
    return 0;
}
static int __init m_init(void)
{
    thr = kthread_run(run, NULL, "tio-dstate");
    return IS_ERR(thr) ? PTR_ERR(thr) : 0;
}
static void __exit m_exit(void) { if (!IS_ERR_OR_NULL(thr)) kthread_stop(thr); }
module_init(m_init); module_exit(m_exit);
MODULE_LICENSE("GPL");
```

编译（在板上）：

```bash
mkdir -p /tmp/dstate && cd /tmp/dstate
# 写入 dstate.c 和 Makefile(obj-m += dstate.o)
make -C /lib/modules/$(uname -r)/build M=$PWD modules
insmod dstate.ko
sleep 125
dmesg | tail -60        # hung task 报告
rmmod dstate
```

**期望答案 / 判据**

- 约 120 秒后出现 `INFO: task tio-dstate:... blocked for more than 120 seconds.`，栈里能看到 `schedule_timeout` / `schedule`。
- `tainted` 会因加载模块变化（`O` 位），不是崩溃。
- 若把 `hung_task_panic=1`，同样的场景会 panic——这是生产环境要避免的配置。
- 清理后线程消失；模块可卸载。

**风险**：模块加载/卸载会 taint 内核；不要设 `hung_task_panic=1`；确保有串口可恢复。

---

## A4 `WARN_ON` 的栈与 taint 分析（中级+，低风险）

**题面**

> 写一个模块，在 workqueue 中触发一次 `WARN_ON(1)`；分析 dmesg 里的 WARNING、调用栈、taint 位，并说明 `panic_on_warn` 的影响。

**为什么复杂**

- 需要区分 `WARN` / `BUG` / `panic`；理解 `panic_on_warn`、`tainted` 位、`cut here` 标记。
- 栈里要找到“谁触发了 WARN”，而不是只看最上层。

**要点**

- `WARN_ON(1)` 只告警，不终止；`panic_on_warn=1` 才会 panic。
- `tainted` 的 `O`（out-of-tree module）与 `W`（warning）位会变化；`cat /proc/sys/kernel/tainted`。
- 生产内核常配 `panic_on_warn=1` 做“warning 即重启”，调试内核则保持 0。

**风险**：只产生 warning；模块需卸载。

---

## A5 持续负载下的热/功耗降频（中级，低风险）

**题面**

> 给 Pi 5 加 60 秒持续负载（CPU + SD I/O），每 2 秒采样温度、频率、`get_throttled`，
> 判断是否发生热降频或欠压降频，并解释 `throttled` 位。

**为什么复杂**

- 要同时看 `thermal_zone`、`cpufreq`、`vcgencmd get_throttled`、`measure_clock arm`。
- `throttled` 是**自启动以来的粘滞位**，当前是否降频要看 `scaling_cur_freq`/`measure_clock`。
- 需要区分“热”（温度高）与“电源”（欠压）两类。

**命令骨架**

```bash
( for i in $(seq 1 4); do yes > /dev/null & done; wait ) &
for i in $(seq 1 30); do
  echo "$(date +%T) $(vcgencmd measure_temp) $(vcgencmd measure_clock arm) $(vcgencmd get_throttled) $(cat /sys/class/thermal/thermal_zone0/temp)"
  sleep 2
done
kill %1 2>/dev/null
```

**判据**

- `throttled=0x0` 且频率维持 2.4 GHz：没有降频。
- `0x50000` 之类：历史欠压/降频；当前是否仍在降频看频率和 `0x4` 位。
- 温度接近 80–85°C 时出现频率下降 → 热降频；电压不足看 `0x1/0x10000`。

**风险**：会升温；确保散热，60 秒内结束。

---

## A6 网络软中断/IRQ 分布（中级+，低风险）

**题面**

> 用 `ping -f` 对网关打 10 秒流量，采样 `/proc/interrupts`、`/proc/softirqs`、`/proc/net/softnet_stat`，
> 判断中断是否集中、是否有 softirq backlog/drop，并解释 RPS/RFS 是否生效。

**为什么复杂**

- 需要做前后差值，而不是看累计值；`softnet_stat` 是十六进制列。
- 要区分硬中断、软中断、NAPI poll、qdisc drop。
- 单队列 Wi-Fi 与多核 RPS 的行为不同。

**命令骨架**

```bash
grep -E 'wlan0|mmc|arch_timer' /proc/interrupts > /tmp/irq.before
cp /proc/net/softnet_stat /tmp/softnet.before
ping -f -c 20000 -i 0.001 <gateway> >/dev/null 2>&1
grep -E 'wlan0|mmc|arch_timer' /proc/interrupts > /tmp/irq.after
cp /proc/net/softnet_stat /tmp/softnet.after
diff -u /tmp/irq.before /tmp/irq.after
paste <(cut -d' ' -f1-3 /tmp/softnet.before) <(cut -d' ' -f1-3 /tmp/softnet.after)
```

**判据**

- 硬中断是否只落在 CPU0；`/proc/softirqs` 的 NET_RX 是否集中。
- `softnet_stat` 第 2 列是 dropped；持续增长说明 backlog 溢出。
- 如果 `rps_cpus=1`（只 CPU0）而流量大，可以尝试把 RPS 分散到多核（写 `/sys/class/net/wlan0/queues/rx-0/rps_cpus`，需要恢复）。

**风险**：短时网络 flood；不要打到公网。

---

## A7 为什么这些“高级武器”都没有？（高级，只读/设计）

**题面**

> 这台机器没有 perf、bpftrace、lockdep、KASAN、KCSAN。分别说明它们缺的是用户态工具还是内核配置，
> 各自能发现哪类 bug，以及要获得它们需要付出什么代价。

**判据**

- `perf`/`bpftrace` 是用户态工具缺失；`perf` 还需要内核 `perf_event` 支持（通常有）。
- `lockdep` 需要 `CONFIG_PROVE_LOCKING`；`KASAN` 需要 `CONFIG_KASAN`；`KCSAN` 需要 `CONFIG_KCSAN`——本机都没开。
- 这些选项会显著增加内核体积/运行时开销，生产内核通常不开；要用需自建 debug kernel 或换发行版。
- 没开 KASAN 时，UAF/越界可能表现为随机 crash，很难定位；没开 lockdep 时，死锁只能靠 hung task/栈猜。

---

## A8 pstore / ramoops / kdump 为什么不可用？（中级+，只读）

**题面**

> `/sys/fs/pstore` 是空的，没有 `/proc/vmcore`。说明 pstore、ramoops、kdump 三者的区别，
> 以及在这台 Pi 上要启用它们分别缺什么。

**判据**

- pstore 是“持久化存储后端”的框架；ramoops 需要设备树 `reserved-memory` 里的 `ramoops` 节点和 `CONFIG_PSTORE_RAM`（本机有配置但无节点）。
- kdump 需要 `CONFIG_CRASH_DUMP`、`kexec-tools`、预留 crashkernel 内存；本机都没配。
- 本机只有 `CONFIG_PSTORE_RAM=y` + `PSTORE_CONSOLE=y`，没有后端，所以 `/sys/fs/pstore` 为空。

---

## 推荐练习顺序

1. **A1 深调用图归因**（安全，能练 trace 解析与“噪声/目标”区分）
2. **A6 软中断/IRQ**（安全，练差值分析）
3. **A5 热降频**（安全，练多指标关联）
4. **A2 块 I/O 尾延迟**（安全，练 fio + tracepoint 配对）
5. **A7/A8 能力差距**（只读，练“为什么不能”）
6. **A4 WARN_ON**（模块，低风险）
7. **A3 hung task**（模块，风险最高，最后做）

## 评分建议

| 维度 | 期望 |
|---|---|
| 现象确认 | 先给出可复现命令与原始输出，不先下结论 |
| 归因 | 能区分“一次 syscall 的调用树”和“进程启动期间的所有 syscall” |
| 数据 | 会做前后差值/分位数，而不是看累计值 |
| 假设 | 对尾延迟/中断集中能提出可验证假设 |
| 安全 | 不碰裸块设备、不设 `hung_task_panic=1`、不长时间满载 |
| 清理 | tracefs、模块、RPS、临时文件都恢复 |
