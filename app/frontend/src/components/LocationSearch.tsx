import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { LocationSearchResult, Partition } from "../types";

interface Props {
  partition: Partition;
  groupId: string;
  onSelect: (result: LocationSearchResult) => void;
}

export function LocationSearch({ partition, groupId, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const requestRef = useRef<AbortController | null>(null);
  const skipNextSearch = useRef(false);

  useEffect(() => {
    requestRef.current?.abort();
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    const trimmed = query.trim();
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
        setResults(response.results);
        setStatus(response.results.length ? "idle" : "empty");
      } catch (reason) {
        if ((reason as Error).name !== "AbortError") setStatus("error");
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, partition, groupId]);

  const choose = (result: LocationSearchResult) => {
    skipNextSearch.current = true;
    setQuery(result.label); setResults([]); setStatus("idle"); onSelect(result);
  };

  return <div className="location-search">
    <label htmlFor="location-search-input">Search for a CONUS location</label>
    <div className="location-search-input-wrap">
      <span aria-hidden="true">⌕</span>
      <input id="location-search-input" type="search" value={query}
        placeholder="City, address, park, or landmark"
        autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
      {status === "loading" && <span className="location-search-status">Searching…</span>}
    </div>
    {results.length > 0 && <div className="location-results" role="listbox" aria-label="Location results">
      {results.map((result) => <button key={result.id} type="button" role="option"
        aria-selected="false" onClick={() => choose(result)}>
        <strong>{result.label}</strong><span>{result.type}</span>
        {!result.inside_selected_region && <em>Outside selected region</em>}
      </button>)}
      <small>Search results © OpenStreetMap contributors</small>
    </div>}
    {status === "empty" && <small className="location-feedback">No CONUS locations found.</small>}
    {status === "error" && <small className="location-feedback error">Location search is temporarily unavailable.</small>}
  </div>;
}
