# hung task detector 实测报告：一个 130 秒的 D 状态内核线程

日期：2026-10-22 · 目标：Raspberry Pi 5 Model B Rev 1.0 · Debian GNU/Linux 13 (trixie)
内核：`6.18.39+rpt-rpi-2712`（SMP PREEMPT，`CONFIG_HZ=250`）
串口：`ttyAMA10`，115200 8N1，通过 tio-server 网关执行

---

## 1. 结论摘要

- 写了一个最小模块 `dstate.ko`：加载时创建 kthread `tio-dstate`，调用
  `schedule_timeout_uninterruptible(130 * HZ)` 进入 **D 状态**。
- 约 120 秒后 `khungtaskd` 报出 hung task；首次报告在 dmesg 时间戳 T+128s，
  文本为 `blocked for more than 122 seconds`；5 秒后又报了一次 128 秒。
- 栈完整解释了 D 状态的来源：`schedule_timeout_uninterruptible()` 是主动睡眠，
  不是 I/O 或驱动卡死。
- 加载模块使 `tainted` 从 **0** 变为 **4096**（`O` = out-of-tree），
  `dmesg` 显示 `Tainted: G           O`；hung task 警告本身没有增加 `W`。
- 清理完成：线程醒来后进入可中断等待，`rmmod` 成功；模块、临时文件、sysctl
  全部恢复；`taint=4096` 是粘滞位，只有重启才会清零。

---

## 2. 环境与基线

| 项 | 值 |
|---|---|
| 内核 | `6.18.39+rpt-rpi-2712` |
| `CONFIG_HZ` | 250 |
| `CONFIG_DETECT_HUNG_TASK` | `y` |
| `CONFIG_DEFAULT_HUNG_TASK_TIMEOUT` | 120 |
| `CONFIG_MODULE_SIG` | 未设置（允许 unsigned module） |
| `CONFIG_MODULE_UNLOAD` | `y` |
| `hung_task_timeout_secs` | 120 |
| `hung_task_panic` | 0 |
| `hung_task_check_interval_secs` | 0（默认，等于 timeout/2） |
| 加载前 `tainted` | 0 |
| 加载前 D 状态任务 | 无 |
| 加载前 `warnings` | 0 |

> 为了让检测更确定，实验期间把 `hung_task_check_interval_secs` 临时设为 5，
> 结束后恢复为 0。`hung_task_panic` 始终为 0。

---

## 3. 模块源码

`/tmp/dstate/dstate.c`：

```c
#include <linux/module.h>
#include <linux/kthread.h>
#include <linux/sched.h>

static struct task_struct *sleeper_task;

static int dstate_thread(void *unused)
{
    pr_info("tio-dstate: entering uninterruptible sleep for 130s\n");
    schedule_timeout_uninterruptible(130 * HZ);
    pr_info("tio-dstate: woke up, waiting for unload\n");
    while (!kthread_should_stop())
        schedule_timeout_interruptible(HZ);
    return 0;
}

static int __init dstate_init(void)
{
    sleeper_task = kthread_run(dstate_thread, NULL, "tio-dstate");
    if (IS_ERR(sleeper_task))
        return PTR_ERR(sleeper_task);
    pr_info("tio-dstate: module loaded, kthread pid=%d\n", sleeper_task->pid);
    return 0;
}

static void __exit dstate_exit(void)
{
    if (!IS_ERR_OR_NULL(sleeper_task))
        kthread_stop(sleeper_task);
    pr_info("tio-dstate: module unloaded\n");
}

module_init(dstate_init);
module_exit(dstate_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("tio hung task detector demo");
```

`Makefile`：

```make
obj-m += dstate.o
```

设计要点：

- `schedule_timeout_uninterruptible()` 把任务置为 `TASK_UNINTERRUPTIBLE` 并睡眠，
  这是 **主动构造 D 状态**，不是真的等 I/O。
- 睡眠结束后不立即退出，而是进入 `schedule_timeout_interruptible()` 循环，
  等 `kthread_stop()`；这样模块可以在任意时刻安全卸载，不会出现
  “线程已退出、kthread_stop 访问已释放 task_struct”的问题。

---

## 4. 编译

```bash
cd /tmp/dstate
make -C /lib/modules/$(uname -r)/build M=/tmp/dstate modules
```

实测输出：

```text
make: Entering directory '/usr/src/linux-headers-6.18.39+rpt-rpi-2712'
  CC [M]  dstate.o
  MODPOST Module.symvers
  CC [M]  dstate.mod.o
  CC [M]  .module-common.o
  LD [M]  dstate.ko
make[1]: Leaving directory '/tmp/dstate'
make: Leaving directory '/usr/src/linux-headers-6.18.39+rpt-rpi-2712'
-rw-r--r-- 1 root root 8000 Oct 22 10:17 /tmp/dstate/dstate.ko
```

`modinfo` 确认 vermagic 与运行内核一致：

```text
vermagic: 6.18.39+rpt-rpi-2712 SMP preempt mod_unload modversions aarch64
```

---

## 5. 加载与现场

```bash
insmod /tmp/dstate/dstate.ko
```

加载后立即采样：

```text
taint=4096
   2567 D    dstate_thread                tio-dstate
[ 2652.535299] dstate: loading out-of-tree module taints kernel.
[ 2652.535924] tio-dstate: module loaded, kthread pid=2567
[ 2652.535927] tio-dstate: entering uninterruptible sleep for 130s
```

- `2567 D`：`ps` 的 `STAT` 为 `D`，`WCHAN=dstate_thread`，符合预期。
- `taint=4096`：out-of-tree 模块的 `O` 位。
- 模块的 `pr_info` 也确认了 pid 和进入睡眠的时间点。

---

## 6. hung task 报告（原始）

首次报告：

```text
[ 2780.526773] INFO: task tio-dstate:2567 blocked for more than 122 seconds.
[ 2780.526785]       Tainted: G           O        6.18.39+rpt-rpi-2712 #1 Debian 1:6.18.39-1+rpt1
[ 2780.526793] "echo 0 > /proc/sys/kernel/hung_task_timeout_secs" disables this message.
[ 2780.526797] task:tio-dstate      state:D stack:0     pid:2567  tgid:2567  ppid:2
[ 2780.526807] Call trace:
[ 2780.526811]  __switch_to+0xf0/0x1c8 (T)
[ 2780.526825]  __schedule+0x3c8/0xc18
[ 2780.526830]  schedule+0x3c/0xf0
[ 2780.526836]  schedule_timeout+0x94/0x130
[ 2780.526842]  schedule_timeout_uninterruptible+0x34/0x60
[ 2780.526849]  dstate_thread+0x28/0x58 [dstate]
[ 2780.526858]  kthread+0x14c/0x210
[ 2780.526865]  ret_from_fork+0x10/0x20
```

5 秒后的第二次报告（`hung_task_warnings` 允许重复）：

```text
[ 2785.646873] INFO: task tio-dstate:2567 blocked for more than 128 seconds.
...
```

线程醒来：

```text
[ 2789.998925] tio-dstate: woke up, waiting for unload
```

---

## 7. 栈逐帧解释

| 帧 | 含义 |
|---|---|
| `__switch_to+0xf0` | 真正做上下文切换的架构代码；`(T)` 是栈展开的 task 上下文标记 |
| `__schedule` | 调度器主函数，选择下一个任务 |
| `schedule` | `schedule()` 入口 |
| `schedule_timeout` | 带超时的睡眠，设置定时器 |
| `schedule_timeout_uninterruptible` | 把当前任务设为 `TASK_UNINTERRUPTIBLE` 后调用 `schedule_timeout` |
| `dstate_thread+0x28/0x58 [dstate]` | **我们模块里的函数**；`+0x28` 是调用睡眠的指令偏移，`[dstate]` 表示来自模块 |
| `kthread` | kthread 的启动 trampoline |
| `ret_from_fork` | 内核线程从 fork 返回的入口 |

关键点：栈里没有块设备、网络、文件系统或驱动帧，只有 `schedule_timeout_uninterruptible`
——这说明任务是在**主动睡**，不是被 I/O 卡住。hung task 检测器只关心“D 状态持续多久”，
不需要知道原因；根因要靠栈来判断。

---

## 8. 检测机制与时序

`khungtaskd` 周期性扫描处于 `TASK_UNINTERRUPTIBLE` 且上下文切换计数未变化的任务；
超过 `hung_task_timeout_secs`（120s）就打印一次报告。本次实验的时序：

| 事件 | dmesg 时间戳 | 相对加载 |
|---|---|---|
| 模块加载 / 进入睡眠 | 2652.535 | 0s |
| 首次 hung task 报告（文本 122s） | 2780.526 | **128s** |
| 第二次报告（文本 128s） | 2785.646 | 133s |
| `woke up, waiting for unload` | 2789.998 | 137s |
| 模块卸载 | 2804.589 | 152s |

两个细节需要说明：

1. **报告文本的秒数与 dmesg 绝对时间戳不完全一致**：文本由检测器按自己的扫描/时间基准打印，
   而 dmesg 时间戳是 printk 记录时间；两者相差几秒是正常的。
2. **从“进入睡眠”的 printk 时间戳到实际开始 `schedule_timeout` 可能有一个小延迟**：
   `pr_info` 写串口 console 是同步的，如果 console 输出被阻塞，时间戳会早于真正进入调度的时间。
   本次 `woke up` 在 T+137s 而不是 T+130s，符合“记录时间早于实际睡眠开始”的解释；
   但 D 状态本身确实持续了超过 120 秒，所以检测器在 128s 时命中。

```text
hung_task_timeout_secs=120
hung_task_panic=0
hung_task_check_interval_secs=5（实验期间，之后恢复 0）
hung_task_warnings=10（默认，允许重复报告）
```

如果 `hung_task_panic=1`，同样的场景会触发 panic/重启——生产环境要谨慎。

---

## 9. taint 分析

| 时刻 | `tainted` | 说明 |
|---|---|---|
| 加载前 | `0` | 干净内核 |
| `insmod` 后 | `4096` | `O` = out-of-tree module |
| `rmmod` 后 | `4096` | taint 是粘滞的，卸载不会清除 |
| 重启后 | 才会归零 | 只有 reboot 能清 |

`dmesg` 的 taint 行：

```text
Tainted: G           O        6.18.39+rpt-rpi-2712 ...
```

- `G`：GPL 许可（不是 taint 位，是许可证标记；模块声明了 `MODULE_LICENSE("GPL")`）。
- `O`：加载了树外模块，对应 `tainted=4096`。
- 没有 `E`：`CONFIG_MODULE_SIG` 未启用，不会因“unsigned module”打 `E`。
- hung task 警告本身没有增加 `W`，也没有 `D`（oops）位；`tainted` 仍为 4096。

---

## 10. 清理与恢复

线程在 130s 后醒来，进入可中断等待；随后：

```bash
rmmod dstate
rm -rf /tmp/dstate /tmp/hung_old_interval
echo 0 > /proc/sys/kernel/hung_task_check_interval_secs
```

验证结果：

```text
taint=4096 interval=0 timeout=120
module-unloaded
-- D-state now --          （无输出）
ls: cannot access '/tmp/dstate': No such file or directory
```

- `lsmod` 无 `dstate`。
- 没有残留的 D 状态任务。
- `hung_task_check_interval_secs` 恢复为 0。
- `/tmp/dstate` 已删除。
- `taint=4096` 保留到重启；这是预期的，不是清理失败。

---

## 11. 一个无关观察

采样时 `ps` 还看到：

```text
2176 D    rpi_firmware_property_list   kworker/3:0+events
```

这是 Raspberry Pi 固件属性调用路径上的 kworker，和我们的模块无关；实验前基线没有 D 状态任务，
它是在窗口期内短暂出现的。若它长期保持 D，hung task 检测器也会把它报出来——这类
“真实驱动 D 状态”才是 hung task 在生产中要抓的对象。

---

## 12. 复现步骤

```bash
# 1) 准备源码（内容见第 3 节）
mkdir -p /tmp/dstate && cd /tmp/dstate
# 写入 dstate.c、Makefile

# 2) 编译
make -C /lib/modules/$(uname -r)/build M=/tmp/dstate modules

# 3) 可选：让检测更确定（实验后恢复 0）
echo 5 > /proc/sys/kernel/hung_task_check_interval_secs

# 4) 加载并确认 D 状态
insmod /tmp/dstate/dstate.ko
sleep 1
ps -eo pid,stat,wchan:28,comm | awk '$4=="tio-dstate"'

# 5) 等待 120s+，观察报告
sleep 125
dmesg | grep -B2 -A30 'blocked for more than'

# 6) 清理
rmmod dstate
echo 0 > /proc/sys/kernel/hung_task_check_interval_secs
rm -rf /tmp/dstate
```

---

## 13. 安全提示

- 不要在 `hung_task_panic=1` 的机器上做这个实验，会直接重启。
- 模块会 taint 内核（`O`）；生产机器应避免加载实验模块。
- 确保有串口/带外恢复；如果模块卸载逻辑写错（例如线程已退出仍调用 `kthread_stop`），
  可能触发 use-after-free。
- 本实验未修改 cmdline、未改内核、未重启；只临时改了一个 sysctl 和 tracefs 之外的模块状态。
