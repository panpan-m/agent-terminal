import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronUp,
  Download,
  File as FileIcon,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { pywebviewApi } from "@/lib/terminal-setup";
import { cn, formatBytes } from "@/lib/utils";
import type { SshFileEntry, SshFileList } from "@/lib/types";

const joinPath = (base: string, name: string) =>
  base === "/" ? `/${name}` : `${base.replace(/\/+$/, "")}/${name}`;

const parentPath = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  const parts = trimmed.split("/");
  parts.pop();
  return parts.join("/") || "/";
};

interface DroppedFile {
  /** Path relative to the drop root, e.g. "src/main.py". */
  relative: string;
  file: File;
}

interface DownloadTask {
  id: number;
  name: string;
  /** Where the file landed: full path (desktop), filename (picker) or null. */
  location: string | null;
  loaded: number;
  total: number | null;
  status: "active" | "done" | "error";
  controller: AbortController;
}

interface DownloadSource {
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
}

/** Minimal shape of the File System Access API save-picker handle. */
interface SavePickerHandle {
  name: string;
  createWritable: () => Promise<{
    write: (chunk: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

/** Flatten a drop into files; folders are walked recursively. */
async function collectDroppedFiles(items: DataTransferItemList): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const entries = Array.from(items)
    .map((item) => (item.kind === "file" ? (item.webkitGetAsEntry?.() ?? null) : null))
    .filter(Boolean) as FileSystemEntry[];

  const walk = (entry: FileSystemEntry, prefix: string): Promise<void> =>
    new Promise((resolve) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file(
          (file) => {
            out.push({ relative: prefix + file.name, file });
            resolve();
          },
          () => resolve(),
        );
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const readBatch = (): void =>
          reader.readEntries(async (batch) => {
            if (batch.length === 0) {
              resolve();
              return;
            }
            for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
            readBatch(); // directories can need several reads
          }, () => resolve());
        readBatch();
      } else {
        resolve();
      }
    });

  for (const entry of entries) await walk(entry, "");
  return out;
}

/**
 * Right-hand file panel for an SSH session: browse, download, upload (button
 * or drag & drop, folders included), mkdir, rename, delete.
 */
export function SshFilesPanel({
  sessionId,
  username,
  notify,
}: {
  sessionId: string;
  username?: string;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
}) {
  const [path, setPath] = useState(username === "root" ? "/root" : `/home/${username || "root"}`);
  const [draft, setDraft] = useState(path);
  const [files, setFiles] = useState<SshFileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const downloadSeq = useRef(0);

  useEffect(() => {
    setDraft(path);
  }, [path]);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.sshSftpList(sessionId, target);
        setFiles(result);
        setPath(result.path);
        setSelected(new Set());
      } catch (exc) {
        setError(`${(exc as { code?: string }).code ?? "ERROR"}: ${(exc as Error).message}`);
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const ensureDirectory = async (dir: string) => {
    if (dir === "/" || !dir) return;
    const parts = dir.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      try {
        await api.sshSftpMkdir(sessionId, current);
      } catch {
        /* already exists */
      }
    }
  };

  const uploadFiles = async (dropped: DroppedFile[]) => {
    if (dropped.length === 0) return;
    setUploadState({ done: 0, total: dropped.length });
    const failures: string[] = [];
    for (let index = 0; index < dropped.length; index += 1) {
      const { relative, file } = dropped[index];
      const target = joinPath(path, relative);
      try {
        await ensureDirectory(joinPath(path, relative.slice(0, relative.lastIndexOf("/")) || "/"));
        await api.sshSftpUpload(sessionId, target, file);
      } catch (exc) {
        failures.push(relative);
        if (failures.length === 1) {
          notify(`${(exc as { code?: string }).code ?? "ERROR"} uploading ${relative}`, "error");
        }
      }
      setUploadState({ done: index + 1, total: dropped.length });
    }
    setUploadState(null);
    if (failures.length === 0) notify(`uploaded ${dropped.length} file(s)`, "success");
    await load(path);
  };

  // the desktop shell pushes download progress through this global
  useEffect(() => {
    const holder = window as {
      __tioDlProgress?: (id: number, loaded: number, total: number | null) => void;
    };
    holder.__tioDlProgress = (id, loaded, total) =>
      setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, loaded, total } : d)));
    return () => {
      delete holder.__tioDlProgress;
    };
  }, []);

  const runDownload = async (name: string, source: DownloadSource) => {
    const id = (downloadSeq.current += 1);
    const controller = new AbortController();
    const bridge = pywebviewApi();

    // destination first: the native/picker dialogs need the click gesture
    let desktopPath: string | null = null;
    let picker: SavePickerHandle | null = null;
    if (bridge?.pick_save_path) {
      desktopPath = await bridge.pick_save_path(name);
      if (desktopPath == null) return; // cancelled
    } else {
      const showPicker = (
        window as { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SavePickerHandle> }
      ).showSaveFilePicker;
      if (typeof showPicker === "function") {
        try {
          picker = await showPicker.call(window, { suggestedName: name });
        } catch {
          return; // cancelled
        }
      }
    }
    const location = desktopPath ?? picker?.name ?? null;
    setDownloads((prev) => [...prev, { id, name, location, loaded: 0, total: null, status: "active", controller }]);

    const patch = (fields: Partial<DownloadTask>) =>
      setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, ...fields } : d)));

    try {
      if (desktopPath !== null && bridge?.save_url_to) {
        // desktop: the local python process streams straight to disk
        const result = await bridge.save_url_to(
          `${window.location.origin}${source.path}`,
          desktopPath,
          id,
          source.method,
          source.body ?? null,
        );
        if (!result.ok) {
          if (result.cancelled) {
            setDownloads((prev) => prev.filter((d) => d.id !== id));
            return;
          }
          throw new Error(result.error || "download failed");
        }
        patch({ loaded: result.bytes, status: "done" });
        return;
      }

      const response = await fetch(source.path, {
        method: source.method,
        credentials: "same-origin",
        signal: controller.signal,
        headers: source.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: source.body !== undefined ? JSON.stringify(source.body) : undefined,
      });
      if (!response.ok) {
        let payload: { error?: { code?: string; message?: string } } = {};
        try {
          payload = (await response.json()) as { error?: { code?: string; message?: string } };
        } catch {
          /* non-JSON error body */
        }
        throw new Error(payload.error?.message ?? `download failed (HTTP ${response.status})`);
      }
      const lengthHeader = response.headers.get("content-length");
      const total = lengthHeader ? Number(lengthHeader) : null;
      const reader = response.body?.getReader();
      if (!reader) throw new Error("download stream unavailable");
      let loaded = 0;

      if (picker) {
        const writer = await picker.createWritable();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
          loaded += value.byteLength;
          patch({ loaded, total });
        }
        await writer.close();
        patch({ status: "done" });
        return;
      }

      // plain browser: collect into a blob and hand it to the download shelf
      const parts: BlobPart[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value as unknown as BlobPart);
        loaded += value.byteLength;
        patch({ loaded, total });
      }
      const url = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      patch({ status: "done", location: location ?? "browser downloads" });
    } catch (exc) {
      if ((exc as Error).name === "AbortError") {
        setDownloads((prev) => prev.filter((d) => d.id !== id));
        return;
      }
      notify(`${(exc as Error).message || "ERROR"} — ${name}`, "error");
      patch({ status: "error" });
    } finally {
      // finished tasks linger briefly so the user sees they completed
      window.setTimeout(() => {
        setDownloads((prev) => prev.filter((d) => d.status === "active" || d.status === "error"));
      }, 5000);
    }
  };

  /** One file streams directly; a folder or multiple entries become one zip. */
  const downloadEntries = (items: SshFileEntry[]) => {
    if (items.length === 0) return;
    if (items.length === 1 && !items[0].is_dir) {
      void runDownload(items[0].name, {
        path: api.sshSftpDownloadPath(sessionId, items[0].path),
        method: "GET",
      });
      return;
    }
    const zipName = items.length === 1 ? `${items[0].name}.zip` : `archive-${items.length}-files.zip`;
    void runDownload(zipName, {
      path: api.sshSftpArchivePath(sessionId),
      method: "POST",
      body: { paths: items.map((item) => item.path) },
    });
    setSelected(new Set());
  };

  const mkdir = async () => {
    const name = window.prompt("New directory name");
    if (!name) return;
    try {
      await api.sshSftpMkdir(sessionId, joinPath(path, name));
      await load(path);
    } catch (exc) {
      setError(`${(exc as { code?: string }).code ?? "ERROR"}: ${(exc as Error).message}`);
    }
  };

  const rename = async (oldPath: string, name: string) => {
    const next = window.prompt("New name", name);
    if (!next || next === name) return;
    try {
      await api.sshSftpRename(sessionId, oldPath, joinPath(parentPath(oldPath), next));
      await load(path);
    } catch (exc) {
      setError(`${(exc as { code?: string }).code ?? "ERROR"}: ${(exc as Error).message}`);
    }
  };

  const remove = async (target: string, name: string) => {
    if (!window.confirm(`Delete ${name}?`)) return;
    try {
      await api.sshSftpDelete(sessionId, target);
      await load(path);
    } catch (exc) {
      setError(`${(exc as { code?: string }).code ?? "ERROR"}: ${(exc as Error).message}`);
    }
  };

  const entries = [...(files?.entries ?? [])].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const selectedEntries = entries.filter((entry) => selected.has(entry.path));

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col",
        dragOver && "outline-2 outline-dashed outline-emerald-400/70",
      )}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={async (event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        const dropped = await collectDroppedFiles(event.dataTransfer.items);
        if (dropped.length === 0) {
          const plain = Array.from(event.dataTransfer.files).map((file) => ({ relative: file.name, file }));
          await uploadFiles(plain);
          return;
        }
        await uploadFiles(dropped);
      }}
    >
      <div className="flex items-center gap-1 border-b border-zinc-800/80 px-2 py-1.5">
        <Button size="sm" variant="ghost" title="parent directory" aria-label="Up" onClick={() => void load(parentPath(path))}>
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load(draft);
          }}
          className="h-7 min-w-0 flex-1 px-2 font-mono text-[11px]"
          spellCheck={false}
        />
        <Button size="sm" variant="ghost" title="reload" aria-label="Reload" onClick={() => void load(path)}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <Button size="sm" variant="ghost" title="new folder" aria-label="New folder" onClick={() => void mkdir()}>
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="download selected (folders become one zip)"
          aria-label="Download selected"
          disabled={selectedEntries.length === 0}
          onClick={() => downloadEntries(selectedEntries)}
        >
          <Download className="h-3.5 w-3.5" />
          {selectedEntries.length > 0 ? (
            <span className="text-[10px] leading-none">{selectedEntries.length}</span>
          ) : null}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="upload files"
          aria-label="Upload"
          disabled={uploadState !== null}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploadState ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []).map((file) => ({ relative: file.name, file }));
            event.target.value = "";
            void uploadFiles(picked);
          }}
        />
      </div>

      {uploadState ? (
        <p className="border-b border-zinc-800/80 px-2 py-1 font-mono text-[10px] text-emerald-300">
          uploading {uploadState.done}/{uploadState.total}
        </p>
      ) : null}
      {error ? <p className="border-b border-zinc-800/80 px-2 py-1 text-[11px] text-red-400">{error}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !files ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">
            <Loader2 className="mx-auto h-4 w-4 animate-spin" />
          </p>
        ) : null}
        {!loading && entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-zinc-600">empty directory</p>
        ) : null}
        {entries.map((entry) => (
          <div
            key={entry.path}
            className="group flex items-center gap-2 border-b border-zinc-800/40 px-2 py-1.5 hover:bg-zinc-900/60"
          >
            <input
              type="checkbox"
              aria-label={`select ${entry.name}`}
              className="h-3 w-3 shrink-0 accent-emerald-500"
              checked={selected.has(entry.path)}
              onChange={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                })
              }
            />
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={entry.path}
              onClick={() => {
                if (entry.is_dir) void load(entry.path);
              }}
            >
              {entry.is_dir ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              ) : (
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
              )}
              <span className={cn("truncate text-[12px]", entry.is_dir ? "text-zinc-100" : "text-zinc-300")}>
                {entry.name}
              </span>
              {entry.is_link ? <span className="shrink-0 text-[10px] text-amber-300">link</span> : null}
            </button>
            {!entry.is_dir ? (
              <span className="shrink-0 font-mono text-[10px] text-zinc-500">{formatBytes(entry.size)}</span>
            ) : null}
            <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <Button
                size="sm"
                variant="ghost"
                title={entry.is_dir ? "download folder as zip" : "download"}
                aria-label="Download"
                onClick={() => downloadEntries([entry])}
              >
                <Download className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" title="rename" aria-label="Rename" onClick={() => void rename(entry.path, entry.name)}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" title="delete" aria-label="Delete" onClick={() => void remove(entry.path, entry.name)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {downloads.length > 0 ? (
        <div className="border-t border-zinc-800/80">
          {downloads.map((task) => (
            <div key={task.id} className="border-b border-zinc-800/40 px-2 py-1.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-mono text-[10px]",
                    task.status === "error" ? "text-red-400" : "text-zinc-300",
                  )}
                  title={task.location ?? task.name}
                >
                  {task.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                  {task.status === "active"
                    ? task.total != null
                      ? `${Math.min(100, Math.floor((task.loaded / task.total) * 100))}% · ${formatBytes(task.loaded)}`
                      : formatBytes(task.loaded)
                    : task.status === "done"
                      ? "done"
                      : "failed"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  title={task.status === "active" ? "cancel" : "dismiss"}
                  aria-label={task.status === "active" ? "Cancel download" : "Dismiss"}
                  onClick={() => {
                    if (task.status === "active") {
                      task.controller.abort();
                      void pywebviewApi()?.cancel_save?.(task.id);
                    } else {
                      setDownloads((prev) => prev.filter((d) => d.id !== task.id));
                    }
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              {task.location ? (
                <p
                  className="mt-0.5 truncate font-mono text-[9px] text-zinc-600"
                  title={task.location}
                >
                  {task.location}
                </p>
              ) : null}
              {task.status === "active" ? (
                <div className="mt-1 h-1 w-full overflow-hidden bg-zinc-800">
                  {task.total != null ? (
                    <div
                      className="h-full bg-emerald-400 transition-[width] duration-150"
                      style={{ width: `${Math.min(100, (task.loaded / task.total) * 100)}%` }}
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse bg-emerald-400/60" />
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <p
        className={cn(
          "border-t border-zinc-800/80 px-2 py-1.5 text-center text-[10px]",
          dragOver ? "text-emerald-300" : "text-zinc-600",
        )}
      >
        {dragOver ? `drop to upload to ${path}` : "drop files here to upload"}
      </p>
    </div>
  );
}
