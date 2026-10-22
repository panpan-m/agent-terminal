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
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import type { SshFileList } from "@/lib/types";

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

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
              {!entry.is_dir ? (
                <Button
                  size="sm"
                  variant="ghost"
                  asChild
                  title="download"
                  aria-label="Download"
                >
                  <a
                    href={`/api/ssh/sessions/${encodeURIComponent(sessionId)}/sftp/download?path=${encodeURIComponent(entry.path)}`}
                    download
                  >
                    <Download className="h-3 w-3" />
                  </a>
                </Button>
              ) : null}
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
