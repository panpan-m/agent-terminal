import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronUp,
  ClipboardCopy,
  Download,
  ExternalLink,
  File as FileIcon,
  FolderOpen,
  FolderPlus,
  FolderSync,
  Info,
  Loader2,
  Lock,
  Pencil,
  RefreshCw,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContextMenu, type ContextMenuEntry } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { pywebviewApi, writeClipboardText } from "@/lib/terminal-setup";
import { cn, formatBytes } from "@/lib/utils";
import type { SshFileEntry, SshFileList, SshFileStat } from "@/lib/types";

const joinPath = (base: string, name: string) =>
  base === "/" ? `/${name}` : `${base.replace(/\/+$/, "")}/${name}`;

const parentPath = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  const parts = trimmed.split("/");
  parts.pop();
  return parts.join("/") || "/";
};

/** "0o755" (backend octal string) → 0o755 numeric. */
const parseMode = (mode: string) => parseInt(mode.replace(/^0o/, ""), 8) || 0;

const symbolicPerms = (bits: number) => {
  const triple = (value: number) =>
    `${value & 4 ? "r" : "-"}${value & 2 ? "w" : "-"}${value & 1 ? "x" : "-"}`;
  return `${triple((bits >> 6) & 7)}${triple((bits >> 3) & 7)}${triple(bits & 7)}`;
};

/** Quote a path so it survives being typed into a shell command line. */
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

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
  terminalCwd,
  notify,
  sendToTerminal,
}: {
  sessionId: string;
  username?: string;
  /** Live remote cwd from session status (OSC 7 / shell title); null until one is seen. */
  terminalCwd?: string | null;
  notify: (message: string, tone?: "info" | "error" | "success") => void;
  /** Types text into the owning session's terminal (Paste path to terminal). */
  sendToTerminal?: (text: string) => void;
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
  const [openBusy, setOpenBusy] = useState<Set<string>>(new Set());
  const [followCwd, setFollowCwd] = useState(() => {
    try {
      return window.localStorage.getItem("ssh-follow-cwd") === "1";
    } catch {
      return false;
    }
  });
  const appliedCwd = useRef<string | null>(null);
  const [fileMenu, setFileMenu] = useState<{
    x: number;
    y: number;
    target: SshFileEntry;
    selection: SshFileEntry[];
  } | null>(null);
  const [statTarget, setStatTarget] = useState<SshFileEntry | null>(null);
  const [statInfo, setStatInfo] = useState<SshFileStat | null>(null);
  const [statError, setStatError] = useState<string | null>(null);
  const [permTarget, setPermTarget] = useState<SshFileEntry | null>(null);
  const [permBits, setPermBits] = useState(0);
  const [permBusy, setPermBusy] = useState(false);
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

  // follow mode: jump to the terminal's remote cwd whenever it changes
  useEffect(() => {
    if (!followCwd || !terminalCwd || terminalCwd === appliedCwd.current) return;
    appliedCwd.current = terminalCwd;
    void load(terminalCwd);
  }, [followCwd, terminalCwd, load]);

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

  /** Download to the server's temp dir, open with the OS default app; the
   *  server watches the file and uploads saves back automatically. */
  const openLocal = async (entry: SshFileEntry) => {
    if (entry.is_dir) {
      void load(entry.path);
      return;
    }
    if (openBusy.has(entry.path)) return;
    setOpenBusy((prev) => new Set(prev).add(entry.path));
    try {
      await api.sshSftpOpenLocal(sessionId, entry.path);
      notify(`opened ${entry.name} with local app — saves upload back automatically`, "info");
    } catch (exc) {
      notify(`${(exc as { code?: string }).code ?? "ERROR"}: ${(exc as Error).message}`, "error");
    } finally {
      setOpenBusy((prev) => {
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
    }
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

  /** Context-menu delete: one entry keeps its confirm, many confirm once. */
  const removeEntries = async (items: SshFileEntry[]) => {
    if (items.length === 1) {
      await remove(items[0].path, items[0].name);
      return;
    }
    if (!window.confirm(`Delete ${items.length} entries?`)) return;
    const failures: string[] = [];
    for (const item of items) {
      try {
        await api.sshSftpDelete(sessionId, item.path);
      } catch {
        failures.push(item.name);
      }
    }
    if (failures.length > 0) {
      setError(`failed to delete: ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? " …" : ""}`);
    }
    await load(path);
  };

  const copyPaths = async (items: SshFileEntry[]) => {
    try {
      await writeClipboardText(items.map((item) => item.path).join("\n"));
      notify(items.length === 1 ? "path copied" : `${items.length} paths copied`, "success");
    } catch {
      notify("clipboard unavailable", "error");
    }
  };

  // fetch the full attributes whenever the Properties dialog opens
  useEffect(() => {
    if (!statTarget) {
      setStatInfo(null);
      setStatError(null);
      return;
    }
    let cancelled = false;
    setStatInfo(null);
    setStatError(null);
    api
      .sshSftpStat(sessionId, statTarget.path)
      .then((info) => {
        if (!cancelled) setStatInfo(info);
      })
      .catch((exc) => {
        if (!cancelled) setStatError(`${(exc as { code?: string }).code ?? "ERROR"}: ${(exc as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [statTarget, sessionId]);

  // Escape closes the Properties / Permissions dialogs
  useEffect(() => {
    if (!statTarget && !permTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setStatTarget(null);
        setPermTarget(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [statTarget, permTarget]);

  const applyPermissions = async () => {
    if (!permTarget) return;
    setPermBusy(true);
    try {
      await api.sshSftpChmod(sessionId, permTarget.path, permBits);
      notify(`permissions set to 0${permBits.toString(8).padStart(3, "0")}`, "success");
      setPermTarget(null);
      await load(path);
    } catch (exc) {
      notify(`${(exc as { code?: string }).code ?? "ERROR"}: ${(exc as Error).message}`, "error");
    } finally {
      setPermBusy(false);
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
        <Button
          size="sm"
          variant="ghost"
          title={
            followCwd
              ? "following the terminal's current directory — click to stop"
              : "follow the terminal's current directory (OSC 7 / shell title)"
          }
          aria-label="Follow terminal directory"
          aria-pressed={followCwd}
          onClick={() =>
            setFollowCwd((prev) => {
              const next = !prev;
              try {
                if (next) window.localStorage.setItem("ssh-follow-cwd", "1");
                else window.localStorage.removeItem("ssh-follow-cwd");
              } catch {
                /* preference persistence is best-effort */
              }
              return next;
            })
          }
        >
          <FolderSync className={cn("h-3.5 w-3.5", followCwd ? "text-emerald-400" : "text-zinc-500")} />
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
            className={cn(
              "group flex items-center gap-2 border-b border-zinc-800/40 px-2 py-1.5 hover:bg-zinc-900/60",
              selected.has(entry.path) && "bg-zinc-900/40",
            )}
            onContextMenu={(event) => {
              event.preventDefault();
              // act on the whole selection when the row belongs to it
              const selection = selected.has(entry.path) ? selectedEntries : [entry];
              if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
              setFileMenu({ x: event.clientX, y: event.clientY, target: entry, selection });
            }}
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
              title={entry.is_dir ? entry.path : `${entry.path}\ndouble-click: open with local app`}
              onClick={() => {
                if (entry.is_dir) void load(entry.path);
              }}
              onDoubleClick={() => void openLocal(entry)}
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
              openBusy.has(entry.path) ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-emerald-400" />
              ) : (
                <span className="shrink-0 font-mono text-[10px] text-zinc-500">{formatBytes(entry.size)}</span>
              )
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
        {dragOver ? `drop to upload to ${path}` : "drop to upload · double-click opens files in a local app"}
      </p>

      {fileMenu ? (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          width={236}
          onClose={() => setFileMenu(null)}
          entries={
            [
              fileMenu.selection.length === 1
                ? fileMenu.target.is_dir
                  ? {
                      key: "open",
                      label: "Open",
                      icon: <FolderOpen className="h-3.5 w-3.5" />,
                      onSelect: () => void load(fileMenu.target.path),
                    }
                  : {
                      key: "open-local",
                      label: "Open with local app",
                      icon: <ExternalLink className="h-3.5 w-3.5" />,
                      onSelect: () => void openLocal(fileMenu.target),
                    }
                : null,
              {
                key: "download",
                label:
                  fileMenu.selection.length > 1
                    ? `Download ${fileMenu.selection.length} selected`
                    : "Download",
                icon: <Download className="h-3.5 w-3.5" />,
                onSelect: () => downloadEntries(fileMenu.selection),
              },
              { key: "sep-actions", separator: true },
              fileMenu.selection.length === 1
                ? {
                    key: "rename",
                    label: "Rename",
                    icon: <Pencil className="h-3.5 w-3.5" />,
                    onSelect: () => void rename(fileMenu.target.path, fileMenu.target.name),
                  }
                : null,
              {
                key: "delete",
                label: fileMenu.selection.length > 1 ? `Delete ${fileMenu.selection.length} selected` : "Delete",
                icon: <Trash2 className="h-3.5 w-3.5" />,
                danger: true,
                onSelect: () => void removeEntries(fileMenu.selection),
              },
              { key: "sep-clipboard", separator: true },
              {
                key: "copy-path",
                label: fileMenu.selection.length > 1 ? `Copy ${fileMenu.selection.length} paths` : "Copy full path",
                icon: <ClipboardCopy className="h-3.5 w-3.5" />,
                onSelect: () => void copyPaths(fileMenu.selection),
              },
              fileMenu.selection.length === 1 && sendToTerminal
                ? {
                    key: "paste-to-terminal",
                    label: "Paste path to terminal",
                    icon: <TerminalIcon className="h-3.5 w-3.5" />,
                    onSelect: () => sendToTerminal(shellQuote(fileMenu.target.path)),
                  }
                : null,
              { key: "sep-info", separator: true },
              fileMenu.selection.length === 1
                ? {
                    key: "properties",
                    label: "Properties",
                    icon: <Info className="h-3.5 w-3.5" />,
                    onSelect: () => setStatTarget(fileMenu.target),
                  }
                : null,
              fileMenu.selection.length === 1
                ? {
                    key: "permissions",
                    label: "Permissions",
                    icon: <Lock className="h-3.5 w-3.5" />,
                    onSelect: () => {
                      setPermBits(parseMode(fileMenu.target.mode) & 0o777);
                      setPermTarget(fileMenu.target);
                    },
                  }
                : null,
            ].filter(Boolean) as ContextMenuEntry[]
          }
        />
      ) : null}

      {statTarget ? (
        <div
          role="dialog"
          data-state="open"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={() => setStatTarget(null)}
        >
          <div
            className="w-[24rem] rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-2">
              {statTarget.is_dir ? (
                <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <FileIcon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
              )}
              <p className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{statTarget.name}</p>
              <Button size="sm" variant="ghost" aria-label="Close" onClick={() => setStatTarget(null)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="mt-1 break-all font-mono text-[10px] text-zinc-500">{statTarget.path}</p>
            {statError ? <p className="mt-3 text-[11px] text-red-400">{statError}</p> : null}
            {!statError && !statInfo ? (
              <p className="py-4 text-center text-xs text-zinc-500">
                <Loader2 className="mx-auto h-4 w-4 animate-spin" />
              </p>
            ) : null}
            {statInfo ? (
              <dl className="mt-3 space-y-1.5 text-[11px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">type</dt>
                  <dd className="font-mono text-zinc-300">
                    {statInfo.is_dir ? "directory" : statInfo.is_link ? "symlink" : "file"}
                  </dd>
                </div>
                {statInfo.is_link ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-500">links to</dt>
                    <dd className="max-w-[60%] truncate font-mono text-amber-300" title={statInfo.link_target ?? ""}>
                      {statInfo.link_target ?? "—"}
                    </dd>
                  </div>
                ) : null}
                {!statInfo.is_dir ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-500">size</dt>
                    <dd className="font-mono text-zinc-300">
                      {statInfo.size.toLocaleString()} bytes ({formatBytes(statInfo.size)})
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">permissions</dt>
                  <dd className="font-mono text-zinc-300">
                    {symbolicPerms(parseMode(statInfo.mode) & 0o777)} · 0
                    {(parseMode(statInfo.mode) & 0o777).toString(8).padStart(3, "0")}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">owner / group</dt>
                  <dd className="font-mono text-zinc-300">
                    {statInfo.uid} / {statInfo.gid}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">modified</dt>
                  <dd className="font-mono text-zinc-300">{new Date(statInfo.mtime * 1000).toLocaleString()}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">accessed</dt>
                  <dd className="font-mono text-zinc-300">{new Date(statInfo.atime * 1000).toLocaleString()}</dd>
                </div>
              </dl>
            ) : null}
          </div>
        </div>
      ) : null}

      {permTarget ? (
        <div
          role="dialog"
          data-state="open"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={() => setPermTarget(null)}
        >
          <div
            className="w-[22rem] rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="text-sm font-semibold text-zinc-100">Permissions</p>
            <p className="mt-0.5 break-all font-mono text-[10px] text-zinc-500" title={permTarget.path}>
              {permTarget.path}
            </p>
            <table className="mt-3 w-full text-[11px]">
              <thead>
                <tr className="text-zinc-500">
                  <th />
                  <th className="font-medium">read</th>
                  <th className="font-medium">write</th>
                  <th className="font-medium">exec</th>
                </tr>
              </thead>
              <tbody>
                {(["owner", "group", "others"] as const).map((role, rowIndex) => (
                  <tr key={role}>
                    <td className="py-1 pr-2 text-zinc-400">{role}</td>
                    {[4, 2, 1].map((bit, colIndex) => {
                      const shift = 6 - rowIndex * 3;
                      const checked = (permBits >> shift & bit) !== 0;
                      return (
                        <td key={bit} className="py-1 text-center">
                          <input
                            type="checkbox"
                            aria-label={`${role} ${["read", "write", "execute"][colIndex]}`}
                            className="h-3 w-3 accent-emerald-500"
                            checked={checked}
                            onChange={() => setPermBits((prev) => prev ^ (bit << shift))}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-center font-mono text-[13px] text-emerald-300">
              0{permBits.toString(8).padStart(3, "0")}
              <span className="ml-2 text-zinc-500">{symbolicPerms(permBits)}</span>
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPermTarget(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={permBusy} onClick={() => void applyPermissions()}>
                {permBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Apply
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
