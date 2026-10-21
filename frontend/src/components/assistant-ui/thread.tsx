import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  useMessagePartText,
  type ChatModelAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import { ArrowUp, Copy, RotateCcw, Square } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { SessionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

function messageText(message: ThreadMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function describeFailure(error: unknown): string {
  const failure = error as { code?: string; message?: string; retryable?: boolean };
  const code = failure?.code ?? "ERROR";
  const message = failure?.message ?? String(error);
  const hints: Record<string, string> = {
    WRITE_LOCKED: "The operator owns write control. Take it back in the toolbar to type here.",
    WRITE_DISABLED: "The agent write permission is disabled for this session.",
    DISCONNECTED: "The serial device is not open. Reconnect it from the session card.",
    BUSY: "Another writer is active; try again in a moment.",
    RATE_LIMITED: "Too many commands per second; slow down.",
    TIMEOUT: "The device did not answer in time.",
  };
  return `⚠ ${code} — ${message}${hints[code] ? `\n\n${hints[code]}` : ""}`;
}

function RawText() {
  const part = useMessagePartText();
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-zinc-200">
      {part.text || "(no output)"}
    </pre>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mb-3 flex justify-end">
      <div className="max-w-[85%] rounded-xl rounded-br-sm border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-2">
        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-emerald-300/80">
          operator
        </div>
        <div className="whitespace-pre-wrap break-words font-mono text-[13px] text-emerald-50">
          <MessagePrimitive.Parts components={{ Text: RawText }} />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mb-3 flex justify-start">
      <div className="max-w-[92%] rounded-xl rounded-bl-sm border border-zinc-800 bg-zinc-900/80 px-3.5 py-2">
        <div className="mb-1 flex items-center justify-between gap-6">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">device</span>
          <ActionBarPrimitive.Root hideWhenRunning className="flex items-center gap-1">
            <ActionBarPrimitive.Copy
              title="copy response"
              className="text-zinc-500 transition-colors hover:text-zinc-200"
            >
              <Copy className="h-3.5 w-3.5" />
            </ActionBarPrimitive.Copy>
          </ActionBarPrimitive.Root>
        </div>
        <MessagePrimitive.Parts components={{ Text: RawText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer({ disabled, hint }: { disabled: boolean; hint?: string }) {
  return (
    <div className="border-t border-zinc-800 bg-zinc-950/70 px-4 py-3">
      <ComposerPrimitive.Root className="flex items-end gap-2">
        <ComposerPrimitive.Input
          placeholder={disabled ? "Read-only: take write control first" : "Type a command (e.g. help)"}
          disabled={disabled}
          rows={2}
          autoFocus
          className={cn(
            "max-h-40 min-h-[42px] flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2",
            "font-mono text-[13px] text-zinc-100 placeholder:text-zinc-600",
            "focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:opacity-50",
          )}
        />
        <ComposerPrimitive.Send asChild>
          <Button variant="primary" size="icon" disabled={disabled} title="send">
            <ArrowUp className="h-4 w-4" />
          </Button>
        </ComposerPrimitive.Send>
        <ComposerPrimitive.Cancel asChild>
          <Button variant="ghost" size="icon" title="stop">
            <Square className="h-3.5 w-3.5" />
          </Button>
        </ComposerPrimitive.Cancel>
      </ComposerPrimitive.Root>
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500">
        <span>{hint ?? "Each message is written with CR and its response captured from the write cursor."}</span>
        <span className="font-mono">enter to send</span>
      </div>
    </div>
  );
}

export function SessionThread({ session, canWrite }: { session: SessionStatus; canWrite: boolean }) {
  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal }) {
        const last = messages[messages.length - 1];
        const command = last ? messageText(last) : "";
        if (!command) {
          yield { content: [{ type: "text", text: "(empty command)" }] };
          return;
        }
        try {
          const result = await api.command(session.session_id, { command, timeout_ms: 8000 });
          if (abortSignal.aborted) return;
          const text = result.rx_text.trim().length > 0 ? result.rx_text : "(no output)";
          yield { content: [{ type: "text", text }] };
        } catch (error) {
          yield { content: [{ type: "text", text: describeFailure(error) }] };
        }
      },
    }),
    [session.session_id],
  );
  const runtime = useLocalRuntime(adapter);

  const hint = !canWrite
    ? session.control_owner === "agent"
      ? "The agent owns write control. Take control back to type here."
      : "Session is not open."
    : undefined;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <ThreadPrimitive.Viewport data-testid="console-thread" className="flex-1 overflow-y-auto px-4 py-4">
          <ThreadPrimitive.Empty>
            <div className="mx-auto mt-10 max-w-md text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
                <RotateCcw className="h-4 w-4 text-emerald-400" />
              </div>
              <p className="text-sm text-zinc-300">Conversational serial console</p>
              <p className="mt-1 text-xs text-zinc-500">
                Each message is written to <span className="font-mono">{session.port}</span> and the response is
                captured from that write cursor. Unsolicited output stays in the live RX panel.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2 text-[11px] text-zinc-500">
                {["help", "version", "ping"].map((cmd) => (
                  <span key={cmd} className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono">
                    {cmd}
                  </span>
                ))}
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <ThreadPrimitive.ScrollToBottom className="sticky bottom-2 ml-auto flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/90 text-zinc-300 hover:text-white" />
        </ThreadPrimitive.Viewport>
        <Composer disabled={!canWrite} hint={hint} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
