/**
 * Desktop-pet model manager: lists the bundled default plus user-uploaded VRM
 * models (stored server-side), uploads new ones and switches the active
 * model. Model selection applies immediately.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api, ApiFailure } from "@/lib/api";
import type { PetModel } from "@/lib/types";
import { getTerminalSettings, updateTerminalSettings } from "@/lib/terminal-settings";

const BUILTIN_MODEL_ID = "builtin";
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface PetModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notify?: (message: string, tone?: "info" | "error" | "success") => void;
}

export function PetModelsDialog({ open, onOpenChange, notify }: PetModelsDialogProps) {
  const [models, setModels] = useState<PetModel[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState(getTerminalSettings().petModelId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fail = useCallback(
    (where: string, cause: unknown) => {
      const failure = cause as ApiFailure;
      // A 404 here almost always means the running server predates the pet
      // endpoints: the static UI refreshes from disk, the Python process does not.
      const staleHint = failure.status === 404 ? ";服务端是旧进程,重启 tio 服务端后重试" : "";
      const message = `${failure.code ?? "ERROR"}: ${failure.message ?? String(cause)}`;
      setError(`${where}失败 — ${message}${staleHint}`);
      notify?.(`${where}失败: ${message}${staleHint}`, "error");
    },
    [notify],
  );

  const refresh = useCallback(async () => {
    try {
      const result = await api.petModels();
      setModels(result.models);
    } catch (cause) {
      fail("加载模型列表", cause);
      setModels([]);
    }
  }, [fail]);

  useEffect(() => {
    if (open) {
      setActiveId(getTerminalSettings().petModelId);
      setModels(null);
      setError(null);
      void refresh();
    }
  }, [open, refresh]);

  const select = (id: string) => {
    updateTerminalSettings({ petModelId: id });
    setActiveId(id);
  };

  const upload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".vrm")) {
      setError("请选择 .vrm 模型文件");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("模型超过 64 MB 上限");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const entry = await api.petModelUpload(file);
      await refresh();
      select(entry.id);
      notify?.(`已添加模型 ${entry.name}`, "success");
    } catch (cause) {
      fail("上传", cause);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const remove = async (entry: PetModel) => {
    try {
      await api.petModelDelete(entry.id);
      if (activeId === entry.id) select(BUILTIN_MODEL_ID);
      await refresh();
      notify?.(`已删除 ${entry.name}`, "success");
    } catch (cause) {
      fail("删除", cause);
    }
  };

  const rows: { id: string; name: string; hint: string; entry?: PetModel }[] = [
    { id: BUILTIN_MODEL_ID, name: "内置模型", hint: "AvatarSample_C · VRoid Project 样例" },
    ...(models ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      hint: `${formatSize(entry.size)} · ${new Date(entry.created_at).toLocaleString()}`,
      entry,
    })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[80vh] overflow-y-auto"
        title="桌宠模型"
        description="上传 VRM 模型文件(≤64 MB),切换或删除立即生效。"
      >
        <div className="flex flex-col gap-3">
          {models === null ? <p className="text-xs text-zinc-500">加载中…</p> : null}
          {error ? <p className="rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">{error}</p> : null}

          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <div
                key={row.id}
                className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${
                  activeId === row.id ? "border-emerald-600/60 bg-emerald-950/30" : "border-zinc-800 bg-zinc-950/40"
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-xs text-zinc-200">{row.name}</p>
                  <p className="truncate text-[11px] text-zinc-500">{row.hint}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {activeId === row.id ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                      <Check className="h-3 w-3" /> 使用中
                    </span>
                  ) : (
                    <Button type="button" size="sm" variant="secondary" onClick={() => select(row.id)}>
                      使用
                    </Button>
                  )}
                  {row.entry ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      title={`删除 ${row.name}`}
                      onClick={() => void remove(row.entry!)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".vrm"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-zinc-600">
              模型须为 VRM 格式;请确认模型的许可允许在你的场景中使用。
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" /> {uploading ? "上传中…" : "添加模型"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
