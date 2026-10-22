import { useEffect, useState, type RefObject } from "react";
import { Search } from "lucide-react";
import type { SearchAddon, ISearchOptions } from "@xterm/addon-search";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Shared scrollback search bar: case / regex / whole-word toggles, live match
 * counter and gold/orange match decorations (requires allowProposedApi).
 */
export function TerminalSearchBar({
  searchRef,
  onClose,
}: {
  searchRef: RefObject<SearchAddon | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);

  useEffect(() => {
    const addon = searchRef.current;
    if (!addon?.onDidChangeResults) return;
    const disposable = addon.onDidChangeResults((event) =>
      setResults({ index: event.resultIndex, count: event.resultCount }),
    );
    return () => disposable.dispose();
  }, [searchRef]);

  // decorations is a proposed API and missing from the bundled d.ts
  const options = {
    caseSensitive,
    wholeWord,
    regex,
    decorations: { matchBorder: "#FFD700", activeMatchBorder: "#FF4500" },
  } as unknown as ISearchOptions;

  const run = (backwards: boolean, incremental = false) => {
    const addon = searchRef.current;
    if (!addon || !query) return;
    if (backwards) addon.findPrevious(query, options);
    else addon.findNext(query, { ...options, incremental });
  };

  const rerun = () => {
    setResults(null);
    if (query) run(false, true);
  };

  return (
    <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5">
      <Search className="h-3.5 w-3.5 text-zinc-500" />
      <Input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (event.target.value) run(false, true);
          else setResults(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") run(event.shiftKey);
          if (event.key === "Escape") onClose();
        }}
        placeholder="search scrollback"
        className="h-7 w-64 text-xs"
      />
      <button
        type="button"
        title="match case"
        onClick={() => {
          setCaseSensitive((value) => !value);
          rerun();
        }}
        className={cn(
          "h-7 rounded px-2 font-mono text-[11px]",
          caseSensitive ? "bg-emerald-500/15 text-emerald-200" : "text-zinc-500 hover:text-zinc-200",
        )}
      >
        Aa
      </button>
      <button
        type="button"
        title="regular expression"
        onClick={() => {
          setRegex((value) => !value);
          rerun();
        }}
        className={cn(
          "h-7 rounded px-2 font-mono text-[11px]",
          regex ? "bg-emerald-500/15 text-emerald-200" : "text-zinc-500 hover:text-zinc-200",
        )}
      >
        .*
      </button>
      <button
        type="button"
        title="whole word"
        onClick={() => {
          setWholeWord((value) => !value);
          rerun();
        }}
        className={cn(
          "h-7 rounded px-2 font-mono text-[11px]",
          wholeWord ? "bg-emerald-500/15 text-emerald-200" : "text-zinc-500 hover:text-zinc-200",
        )}
      >
        |w|
      </button>
      <span className="min-w-[4.5rem] text-center font-mono text-[11px] text-zinc-500">
        {results && query ? `${results.index + 1}/${results.count}` : ""}
      </span>
      <Button size="sm" variant="ghost" onClick={() => run(false)} disabled={!query}>
        Next
      </Button>
      <Button size="sm" variant="ghost" onClick={() => run(true)} disabled={!query}>
        Prev
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
