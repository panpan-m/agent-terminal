/**
 * Two-language UI (English / 简体中文).
 *
 * The English source text is the translation key, so a missing entry falls back
 * to English instead of rendering a blank or a raw key — translations are purely
 * additive and a half-finished locale is still usable.
 *
 * Usage:
 *   const t = useT();
 *   <span>{t("Sessions")}</span>
 *   t("{n} open", { n: 3 })
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "en" | "zh";

export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: "en", label: "English", short: "EN" },
  { id: "zh", label: "简体中文", short: "中" },
];

const STORAGE_KEY = "tio-lang";

/** English source text → 简体中文. */
const ZH: Record<string, string> = {
  "Sessions": "会话",
  "Terminal": "终端",
  "MCP": "MCP",
  "Logs": "日志",
  "Serial sessions": "串口会话",
  "none configured": "未配置",
  "{n} open": "{n} 个已打开",
  "serial · mcp": "串口 · MCP",
  "Auto reconnect": "断线自动重连",
  "Baud": "波特率",
  "Buffer": "缓冲",
  "Data bits": "数据位",
  "Display name": "显示名称",
  "Flow control": "流控",
  "New serial session": "新建串口会话",
  "No serial session yet": "还没有串口会话",
  "Open behaviour": "打开方式",
  "Open on start": "启动时打开",
  "Parity": "校验",
  "Port": "端口",
  "Reset": "复位",
  "Session id": "会话 ID",
  "Stop bits": "停止位",
  "Transcript": "转录",
  "The server will keep the only handle to this port.": "服务端将保持对该端口的唯一句柄。",
  "apply the configured DTR/RTS reset sequence": "执行已配置的 DTR/RTS 复位序列",
  "configure session": "配置会话",
  "delete session": "删除会话",
  "lowercase, used by MCP": "小写，供 MCP 使用",
  "open the interactive terminal tab": "打开交互终端标签",
  "ports open": "端口已打开",
  "rx / tx bytes · ring buffer usage": "收/发字节 · 环形缓冲占用",
  "server uptime": "服务运行时长",
  "sessions configured": "已配置会话",
  "sessions where the agent owns write": "agent 持有写权限的会话",
  "the agent owns this port; the operator terminal observes only": "agent 独占该端口，操作员终端仅可观测",
  "break the agent's exclusive claim so another agent can start": "解除 agent 的独占，让其他 agent 可以开始",
  "Observe": "观测",
  "Release lease": "解除租约",
  "New session": "新建会话",
  "New Session": "新建会话",
  "BREAK": "BREAK",
  "Browser keys vs this terminal": "浏览器快捷键与本终端",
  "Capture Ctrl+B": "捕获 Ctrl+B",
  "Capture Escape": "捕获 Escape",
  "Clear": "清屏",
  "Find": "查找",
  "Info": "信息",
  "Keys": "按键",
  "Reconnect": "重连",
  "Release port": "释放端口",
  "Reset terminal": "重置终端",
  "browser-reserved keys and alternatives": "浏览器占用的按键与替代方案",
  "clear the screen": "清屏",
  "clear view (does not clear the buffer)": "清空视图（不清空缓冲）",
  "close the port and release the device for other programs": "关闭端口，把设备让给其他程序",
  "download raw bytes with timestamps": "下载带时间戳的原始字节",
  "jump to live output": "跳到最新输出",
  "reset terminal state (fixes a stuck screen after a full-screen TUI)": "重置终端状态（修复全屏 TUI 后的卡屏）",
  "resume the stream from the last received cursor": "从上次接收的游标继续",
  "search the scrollback (Ctrl+Shift+F)": "搜索回滚区（Ctrl+Shift+F）",
  "send a serial BREAK (250 ms framing break, not a byte)": "发送串口 BREAK（250 ms 帧间隔，不是数据字节）",
  "the agent drives this port; the terminal is a read-only audit view": "agent 正在操作该端口，终端为只读审计视图",
  "toggle the session status panel": "切换会话状态面板",
  "No terminal session is open.": "没有打开的终端会话。",
  "clear tab color": "清除标签颜色",
  "Open a serial session": "打开串口会话",
  "Bearer token": "Bearer 令牌",
  "Endpoint": "接入地址",
  "Install prompt": "安装提示",
  "MCP 2.x, stateful sessions": "MCP 2.x，有状态会话",
  "Point any MCP client here; the token stays on this machine.": "把这个地址填进任意 MCP 客户端；令牌只留在本机。",
  "Tools": "工具",
  "copy just the stdio shim command": "只复制 stdio 代理命令",
  "Status": "状态",
  "Transport": "传输",
  "Auth": "认证",
  "Refresh": "刷新",
  "Session bindings": "会话绑定",
  "Copy URL": "复制地址",
  "Copy prompt": "复制提示",
  "Copy stdio command": "复制 stdio 命令",
  "Logs & audit": "日志与审计",
  "One JSONL transcript per session · global audit log.": "每个会话一份 JSONL 转录 · 全局审计日志。",
  "show only one MCP client's activity": "只看某个 MCP 客户端的活动",
  "all clients": "全部客户端",
  "transcript": "转录",
  "audit": "审计",
  "time": "时间",
  "client": "客户端",
  "kind": "类型",
  "detail": "详情",
  "No events yet.": "暂无事件。",
  "Export": "导出",
  "{n} events": "{n} 条事件",
  "loading…": "加载中…",
  "status": "状态",
  "state": "连接状态",
  "control": "控制权",
  "lease": "租约",
  "free": "空闲",
  "rx / tx": "收/发",
  "buffer": "缓冲",
  "reconnects": "重连次数",
  "opened": "打开时间",
  "last error": "最近错误",
  "none": "无",
  "match case": "区分大小写",
  "regular expression": "正则表达式",
  "search scrollback": "搜索回滚区",
  "whole word": "全词匹配",
  "Agent permissions": "Agent 权限",
  "Baud rate": "波特率",
  "Bits": "数据位",
  "Control": "控制权",
  "Delay (ms)": "延时（毫秒）",
  "No custom sequence — the built-in 3-step pulse is used.": "没有自定义序列时使用内置三步脉冲。",
  "Reset sequence (DTR/RTS, then delay)": "复位序列（DTR/RTS，然后延时）",
  "Saving closes and reopens an open session atomically; runtime counters are kept.": "保存会原子地关闭并重新打开会话；运行计数保留。",
  "Stop": "停止位",
  "immutable; used by MCP tools": "不可修改，MCP 工具据此识别",
  "prefer /dev/serial/by-id on Linux": "Linux 下建议用 /dev/serial/by-id",
  "preserve avoids touching DTR/RTS": "preserve 不会触碰 DTR/RTS",
  "Appearance": "外观",
  "Clipboard": "剪贴板",
  "Custom capture keys": "自定义捕获按键",
  "Font family": "字体",
  "Font size": "字号",
  "Keyboard capture": "按键捕获",
  "Scrollback": "回滚行数",
  "Settings": "设置",
  "Theme": "主题",
  "CSS font stack; monospace fallback is appended by the browser": "CSS 字体栈，浏览器会追加等宽回退",
  "comma-separated, e.g. F11, Ctrl+T, Alt+D": "逗号分隔，例如 F11, Ctrl+T, Alt+D",
  "1–200000 lines": "1–200000 行",
  "Theme, terminal appearance and keyboard behaviour; stored in this browser.": "主题、终端外观与按键行为，保存在本浏览器。",
  "session {id} created": "会话 {id} 已创建",
  "configuration saved": "配置已保存",
  "session opened": "会话已打开",
  "session closed": "会话已关闭",
  "session deleted": "会话已删除",
  "reset applied ({n} steps)": "已应用复位（{n} 步）",
  "control → {owner}": "控制权 → {owner}",
  "cfg": "已配置",
  "open": "已打开",
  "agent": "agent",
  "last rx": "最近收包",
  "Close": "关闭",
  "Open": "打开",
  "Session id and port are required.": "会话 ID 与端口为必填项。",
  "Take control": "收回控制",
  "Hand to agent": "交给 agent",
  "BREAK sent (250 ms)": "已发送 BREAK（250 ms）",
  "Rename session": "重命名会话",
  "Save terminal output": "保存终端输出",
  "Increase font size": "放大字号",
  "Decrease font size": "缩小字号",
  "Fullscreen": "全屏",
  "Exit fullscreen": "退出全屏",
  "Pin tab": "固定标签",
  "Unpin tab": "取消固定",
  "Session name": "会话名称",
  "Lease": "租约",
  "opening": "打开中",
  "reconnecting": "重连中",
  "error": "错误",
  "closed": "已关闭",
  "unconfigured": "未配置",
  "rx": "收",
  "tx": "发",
  "buf": "缓冲",
  "transport": "传输",
  "auth": "认证",
  "tools": "工具",
  "session": "会话",
  "name": "名称",
  "description": "描述",
  "serial surface": "串口能力面",
  "bearer": "Bearer",
  "token present": "令牌已就位",
  "token missing": "令牌缺失",
  "input": "输入",
  "output": "输出",
  "access": "访问",
  "read": "读",
  "write": "写",
  "open a serial session in the workspace, then pick it here.": "先在终端页打开一个串口会话，再回到这里选择。",
  "input disabled: agent owns control": "输入已禁用：agent 持有控制权",
  "no sessions": "无会话",
  "clear": "清屏",
  "color": "颜色",
  "search this scrollback (case / regex / whole word)": "搜索本回滚区（区分大小写 / 正则 / 全词）",
  "Settings (theme, terminal, keys, clipboard)": "设置（主题、终端、按键、剪贴板）",
  "assert": "拉高",
  "deassert": "拉低",
  "preserve": "保持不变",
  "assert DTR/RTS": "拉高 DTR/RTS",
  "deassert DTR/RTS": "拉低 DTR/RTS",
  "preserve (do not touch DTR/RTS)": "保持不变（不触碰 DTR/RTS）",
  "custom / not listed": "自定义 / 未列出",
  "Audit": "审计",
  "Edit custom theme (JSON)": "编辑自定义主题（JSON）",
  "Blinking cursor": "光标闪烁",
  "Capture Escape — fixes vi Escape being swallowed by the browser": "捕获 Escape —— 修复浏览器吞掉 vi 的 Escape",
  "Capture Ctrl+B — tmux prefix": "捕获 Ctrl+B —— tmux 前缀键",
  "Shift+Enter sends ESC+CR — newline instead of submit in TUIs (Claude Code)": "Shift+Enter 发送 ESC+CR —— 在 TUI 中换行而不提交（Claude Code）",
  "stty size sync on serial open — aligns full-screen TUIs (apt/dpkg)": "串口打开时同步 stty 尺寸 —— 让全屏 TUI 对齐（apt/dpkg）",
  "Auto-copy on selection": "选中即复制",
  "Middle-click paste": "中键粘贴",
  "Ctrl+Shift+C / Ctrl+Shift+V copy / paste": "Ctrl+Shift+C / Ctrl+Shift+V 复制 / 粘贴",
  "Ctrl+V pastes — off sends ^V to the session (quoted-insert)": "Ctrl+V 粘贴 —— 关闭则把 ^V 发给会话（quoted-insert）",
  "classic dark (default)": "经典深色（默认）",
  "classic light": "经典浅色",
  "paper engineering drawing": "纸质工程图",
  "your JSON theme (edit below)": "你的 JSON 主题（在下面编辑）",
  "port": "端口",
  "lost": "丢弃",
  "port, state, control": "端口、状态、控制权",
  "Status refreshes with the session poll (3 s).": "状态每 3 秒随会话轮询刷新。",
  "DTR/RTS/CTS/DSR/CD/RI live in the card above.": "DTR/RTS/CTS/DSR/CD/RI 见上方卡片。",
  "human": "操作员",
  "observe only": "仅观测",
  "agent control": "agent 控制",
  "agent owns control": "agent 持有控制权",
  "operator control": "操作员控制",
  "LIVE RX": "实时接收",
  "live raw serial · no local echo · keys go straight to the device": "原始串口直连 · 无本地回显 · 按键直达设备",
  "+ session": "+ 会话",
  "● live": "● 已连接",
  "○ disconnected": "○ 已断开",
  "raw serial · no local echo · keys go straight to the device": "原始串口 · 无本地回显 · 按键直达设备",
  "dropped {n} bytes (slow reader)": "丢弃 {n} 字节（读取过慢）",
  "live rx": "实时接收",
  "auto": "自动",
  "live ↓": "实时 ↓",
};

function detectLang(): Lang {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    /* storage disabled */
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export type TFn = (text: string, vars?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* storage disabled */
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);

  const t = useCallback<TFn>(
    (text, vars) => interpolate(lang === "zh" ? (ZH[text] ?? text) : text, vars),
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}

/** Convenience for components that only need the translator. */
export function useT(): TFn {
  return useI18n().t;
}
