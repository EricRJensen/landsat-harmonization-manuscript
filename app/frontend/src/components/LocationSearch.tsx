import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "../api";
import type { LocationSearchResult, Partition } from "../types";
import "../setup.css";

interface Props {
  partition: Partition;
  groupId: string;
  onSelect: (result: LocationSearchResult) => void;
  showRegionMembership?: boolean;
}

export function LocationSearch({ partition, groupId, onSelect, showRegionMembership = true }: Props) {
  const id = useId();
  const inputId = `${id}-location`;
  const listId = `${id}-results`;
  const statusId = `${id}-status`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestRef = useRef<AbortController | null>(null);
  const skipNextSearch = useRef(false);

  useEffect(() => {
    requestRef.current?.abort();
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    const trimmed = query.trim();
    setActiveIndex(-1);
    setResults([]);
    if (trimmed.length < 3) {
      setResults([]); setStatus("idle");
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const response = await api.locationSearch(trimmed, partition, groupId, controller.signal);
        if (controller.signal.aborted) return;
        setResults(response.results);
        setStatus(response.results.length ? "idle" : "empty");
      } catch (reason) {
        if ((reason as Error).name !== "AbortError") setStatus("error");
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, partition, groupId]);

  const choose = (result: LocationSearchResult) => {
    requestRef.current?.abort();
    skipNextSearch.current = result.label !== query;
    setQuery(result.label); setResults([]); setStatus("idle"); setOpen(false); setActiveIndex(-1);
    inputRef.current?.focus();
    onSelect(result);
  };

  const expanded = open && results.length > 0;
  useEffect(() => {
    if (expanded && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeIndex, id]);

  const navigate = (event: KeyboardEvent<HTMLInputElement | HTMLButtonElement>) => {
    if (event.key === "Escape") {
      event.preventDefault(); inputRef.current?.focus(); setOpen(false); setActiveIndex(-1);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
      event.preventDefault(); setOpen(true);
      setActiveIndex((current) => event.key === "ArrowDown"
        ? (current + 1) % results.length
        : current <= 0 ? results.length - 1 : current - 1);
      inputRef.current?.focus();
    } else if (event.key === "Enter" && expanded && activeIndex >= 0) {
      event.preventDefault(); choose(results[activeIndex]);
    }
  };

  return <div className="location-search" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActiveIndex(-1); }
  }}>
    <label htmlFor={inputId}>Search for a CONUS location</label>
    <div className="location-search-input-wrap">
      <span aria-hidden="true">⌕</span>
      <input id={inputId} ref={inputRef} type="search" value={query}
        role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId}
        aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={statusId} onKeyDown={navigate} onFocus={() => setOpen(true)}
        placeholder="City, address, park, or landmark"
        autoComplete="off" onChange={(event) => { setQuery(event.target.value); setOpen(true); }} />
      {status === "loading" && <span className="location-search-status">Searching…</span>}
    </div>
    {expanded && <div className="location-results">
      <div id={listId} role="listbox" aria-label="Location results">
      {results.map((result, index) => <button key={result.id} id={`${id}-option-${index}`} type="button" role="option"
        aria-selected={index === activeIndex} onFocus={() => setActiveIndex(index)} onKeyDown={navigate} onClick={() => choose(result)}>
        <strong>{result.label}</strong><span>{result.type}</span>
        {showRegionMembership && !result.inside_selected_region && <em>Outside selected region</em>}
      </button>)}
      </div>
      <small>Search results © OpenStreetMap contributors</small>
    </div>}
    <span id={statusId} className={status === "empty" || status === "error" ? `location-feedback ${status === "error" ? "error" : ""}` : "setup-sr-only"} role="status" aria-live="polite">
      {status === "loading" ? "Searching for locations…" : status === "empty" ? "No matching locations in CONUS. Try a nearby city, park, or landmark."
        : status === "error" ? "Location search is unavailable. Try again or choose another sample location."
          : expanded ? `${results.length} locations found. Use the up and down arrow keys, then Enter to select.` : "Type at least three characters to search."}
    </span>
  </div>;
}
