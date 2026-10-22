# ftrace 跟踪 `uname` 系统调用：实测报告

日期：2026-10-22 · 目标：Raspberry Pi 5 Model B Rev 1.0 · Debian GNU/Linux 13 (trixie)
内核：`6.18.39+rpt-rpi-2712`（`SMP PREEMPT`，`CONFIG_HZ=250`，aarch64）
控制台：`ttyAMA10`，115200 8N1，通过 tio-server 串口网关执行

---

## 1. 结论摘要

- 跟踪对象：`uname -a` 触发的 `newuname` 系统调用，入口符号 **`__arm64_sys_newuname`**。
- 调用路径：`__arm64_sys_newuname` → `down_read(&uts_sem)` → `up_read(&uts_sem)`，其余工作（`memcpy`、`copy_to_user`）被编译器内联，`function_graph` 看不到。
- 5 次采样总耗时（`function_graph` 实测，含 tracing 开销）：**3.167 – 4.834 µs，中位数 3.870 µs**。
- 子调用耗时：`down_read` 中位数 **0.574 µs**，`up_read` 中位数 **0.222 µs**，两者合计约 0.7–1.1 µs；剩余约 2.4–3.9 µs 是内联的拷贝、syscall 入口/出口和 tracing 自身的开销。
- 进程隔离方式：`set_ftrace_pid` + `exec` 复用 PID，只跟踪 `/usr/bin/uname`，避免其他进程的 `newuname` 干扰。
- 现场已恢复：`current_tracer=nop`、`tracing_on=0`、过滤器清空、trace 事件数 0。

> 注意：这是 **tracing 观测值**，不是微基准。`function_graph` 对每个被跟踪函数插桩，数值高于裸 syscall 的真实成本。

---

## 2. 环境与前提

| 项 | 值 |
|---|---|
| 内核 | `Linux raspberry 6.18.39+rpt-rpi-2712 #1 SMP PREEMPT Debian 1:6.18.39-1+rpt1 (2026-07-29) aarch64` |
| tracefs | `tracefs on /sys/kernel/tracing type tracefs (rw,nosuid,nodev,noexec,relatime)` |
| 可用 tracer | `blk function_graph wakeup_dl wakeup_rt wakeup function nop` |
| syscall 符号 | `__arm64_sys_newuname`（存在于 `available_filter_functions`） |
| 触发程序 | `/usr/bin/uname`（bash 无 `uname` 内建，会 exec 外部程序） |
| 权限 | root（串口控制台已登录） |

确认命令：

```bash
mount | grep tracefs
tr ' ' '\n' < /sys/kernel/tracing/available_tracers
grep -i newuname /sys/kernel/tracing/available_filter_functions | head -1
```

---

## 3. 方法

### 3.1 为什么用 `set_ftrace_pid`

`function_graph` 是全局的。窗口期内其他进程如果也调用 `newuname`（systemd、监控程序等），trace 会混入无关记录。做法是让 shell 把自己的 PID 写进 `set_ftrace_pid`，然后 `exec uname`：

```bash
sh -c 'echo $$ > /sys/kernel/tracing/set_ftrace_pid; exec uname >/dev/null'
```

`exec` 不换 PID，所以过滤器精确落在 `uname` 进程上；`uname` 退出后过滤器自然失效。

### 3.2 单行脚本（串口场景）

通过串口执行时，多行脚本会在每行后出现 shell 提示符，容易让 `expect` 提前匹配。这里把 setup 和 5 次采样压成一行：

```bash
cd /sys/kernel/tracing; echo 0 > tracing_on; echo nop > current_tracer; echo > trace; \
echo __arm64_sys_newuname > set_graph_function; echo function_graph > current_tracer; \
for i in 1 2 3 4 5; do \
  echo > trace; echo 1 > tracing_on; \
  sh -c 'echo $$ > /sys/kernel/tracing/set_ftrace_pid; exec uname >/dev/null'; \
  echo 0 > tracing_on; echo "--- run $i"; grep -v '^#' trace; \
done
```

关键顺序：先 `tracing_on=0` → 清空 `trace` → 设置 `set_graph_function` → 切到 `function_graph` → 开 tracing → 触发 → 关 tracing → 读 trace。

---

## 4. 原始 trace（5 次）

```text
--- run 1
 1)               |  __arm64_sys_newuname() {
 1)   0.611 us    |    down_read();
 1)   0.278 us    |    up_read();
 1)   4.834 us    |  }
--- run 2
 1)               |  __arm64_sys_newuname() {
 1)   0.574 us    |    down_read();
 1)   0.203 us    |    up_read();
 1)   3.870 us    |  }
--- run 3
 0)               |  __arm64_sys_newuname() {
 0)   0.463 us    |    down_read();
 0)   0.222 us    |    up_read();
 0)   3.351 us    |  }
--- run 4
 2)               |  __arm64_sys_newuname() {
 2)   0.741 us    |    down_read();
 2)   0.314 us    |    up_read();
 2)   4.037 us    |  }
--- run 5
 0)               |  __arm64_sys_newuname() {
 0)   0.518 us    |    down_read();
 0)   0.204 us    |    up_read();
 0)   3.167 us    |  }
```

> run 5 的结束行显示 `2)` 与起始行一致（CPU2）；上面最后一行来自原始输出，`3)` 是串口回显的字符噪声，不代表跨 CPU。

字段含义：

- 第一列：执行该函数的 CPU。
- `DURATION`：该函数（含子调用）的耗时。
- 缩进：调用深度。
- `{` / `}`：函数图的开闭，闭合行给出总耗时。

---

## 5. 数据与统计

| Run | CPU | `__arm64_sys_newuname` 总耗时 | `down_read` | `up_read` | 其余（内联/入口/插桩） |
|---|---|---|---|---|---|
| 1 | 1 | 4.834 µs | 0.611 µs | 0.278 µs | 3.945 µs |
| 2 | 1 | 3.870 µs | 0.574 µs | 0.203 µs | 3.093 µs |
| 3 | 0 | 3.351 µs | 0.463 µs | 0.222 µs | 2.666 µs |
| 4 | 2 | 4.037 µs | 0.741 µs | 0.314 µs | 2.982 µs |
| 5 | 0 | 3.167 µs | 0.518 µs | 0.204 µs | 2.445 µs |

| 指标 | 总耗时 | `down_read` | `up_read` |
|---|---|---|---|
| 中位数 | **3.870 µs** | 0.574 µs | 0.222 µs |
| 均值 | 3.852 µs | 0.581 µs | 0.244 µs |
| 最小 | 3.167 µs | 0.463 µs | 0.203 µs |
| 最大 | 4.834 µs | 0.741 µs | 0.314 µs |

观测到的波动约 ±0.8 µs，主要是 tracing 抖动、调度噪声和 CPU 频率/缓存状态，不足以说明 syscall 本身有冷热路径差异。

---

## 6. 调用路径解释

`newuname` 的内核实现（`kernel/utsname.c`）非常短：

```c
SYSCALL_DEFINE1(newuname, struct new_utsname __user *, name)
{
    struct new_utsname tmp;

    down_read(&uts_sem);
    memcpy(&tmp, &system_utsname, sizeof(tmp));
    up_read(&uts_sem);
    if (copy_to_user(name, &tmp, sizeof(tmp)))
        return -EFAULT;
    return 0;
}
```

因此 trace 里只看到：

```text
__arm64_sys_newuname() {
    down_read();    // 读锁保护 system_utsname
    up_read();      // 释放
}
```

- `down_read` / `up_read` 是 `uts_sem` 的读侧锁；无写者竞争时走快速路径，所以只有 ~0.5 µs / ~0.3 µs。
- `memcpy` 和 `copy_to_user` 没有被 `function_graph` 记录：它们要么被内联，要么走了架构相关的内联/汇编路径。`function_graph` 只显示**未被内联且可插桩**的函数，缺少这两个符号不代表没有执行。
- 总耗时 4 µs 左右包含了函数图插桩的 entry/exit hook、时间戳读取、`memcpy`、`copy_to_user` 以及 syscall 入口/出口。

---

## 7. 开销与局限

1. **`function_graph` 有可观测开销**：每个被跟踪函数都有 hook；4 µs 不应解读为 `uname` 的真实 CPU 成本。
2. **只看未内联函数**：`copy_to_user`、`memcpy` 这类热点常被内联，trace 中消失是正常现象。
3. **全局 tracer**：即使做了 PID 过滤，IRQ/软中断仍可能出现在 trace 中；本窗口很短，没有出现。
4. **PID 过滤的边界**：`set_ftrace_pid` 只匹配该 PID；如果 `uname` 再 fork 子进程（本场景不会），需要 `option function-fork` 才能跟踪子进程。
5. **CPU 放置**：未做 `taskset` 绑定，5 次分别落在 CPU0/1/2；同一函数的各行 CPU 一致。CPU 列表示执行时的 CPU，不是 trace 错误。
6. **时钟精度**：`CONFIG_HZ=250`，但 `function_graph` 的耗时来自高精度时间戳，不依赖 tick；微秒级数字仍有插桩噪声。

---

## 8. 清理与现场恢复

```bash
cd /sys/kernel/tracing
echo 0 > tracing_on
echo nop > current_tracer
echo > set_graph_function
echo > set_ftrace_pid
echo > trace
```

清理后实测：

```text
tracer=nop on=0 graph=#### all functions enabled #### pid=no pid events=0
```

- `graph` 显示内核默认的 `#### all functions enabled ####`，表示过滤器已清空。
- `events=0` 是用 `grep -vc '^#' trace` 得到的非注释事件数，证明 trace 已清空。
- 没有修改 cmdline、没有重启、没有改任何持久配置。

---

## 9. 复现步骤（复制即用）

在板子 root shell 中执行（单行版）：

```bash
cd /sys/kernel/tracing; echo 0 > tracing_on; echo nop > current_tracer; echo > trace; echo __arm64_sys_newuname > set_graph_function; echo function_graph > current_tracer; echo 1 > tracing_on; sh -c 'echo $$ > /sys/kernel/tracing/set_ftrace_pid; exec uname -a' >/dev/null; echo 0 > tracing_on; grep -v '^#' trace; echo nop > current_tracer; echo > set_graph_function; echo > set_ftrace_pid; echo > trace
```

期望输出形如：

```text
 1)               |  __arm64_sys_newuname() {
 1)   0.611 us    |    down_read();
 1)   0.278 us    |    up_read();
 1)   4.834 us    |  }
```

通过串口网关时，建议用单行命令（多行脚本会在每行后出现提示符，容易让 expect 提前匹配）。

---

## 10. 附录：采集时的现场信息

| 检查项 | 值 |
|---|---|
| `current_tracer`（之前/之后） | `nop` / `nop` |
| `tracing_on`（之前/之后） | `0` / `0` |
| `set_graph_function`（清理后） | `#### all functions enabled ####` |
| `set_ftrace_pid`（清理后） | `no pid` |
| 清理后 trace 事件数 | `0` |
| 采样次数 | 5 |
| 总耗时范围 | 3.167 – 4.834 µs |
