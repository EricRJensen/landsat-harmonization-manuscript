import type { AnalysisConfig, EvaluationResponse, GeoJsonFeatureCollection, HarmonizationDirection, IndexName, LocationSearchResult, MapBounds, MapTiles, NestedEcoregion, Partition, PolygonAnalysisResponse, RegionSummary, TimeseriesResponse } from "./types";

/** FastAPI validation details are objects; keep them readable at every call site. */
export function apiErrorMessage(body: unknown, status: number): string {
  const fieldLabels: Record<string, string> = {
    start_year: "Start year", end_year: "End year", geometry: "Polygon",
    coefficient_group_id: "Coefficient region", bbox: "Map extent",
  };
  const message = (value: unknown): string | null => {
    if (typeof value === "string" && value.trim()) return value.replace(/^Value error,\s*/i, "");
    if (Array.isArray(value)) {
      const parts = value.map(message).filter((part): part is string => Boolean(part));
      return parts.length ? [...new Set(parts)].join(". ") : null;
    }
    if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      if ("detail" in item) return message(item.detail);
      const description = message(item.msg ?? item.message ?? item.error);
      const location = Array.isArray(item.loc) ? item.loc.filter((part) => typeof part === "string" && part !== "body" && part !== "query") : [];
      const field = location.find((part) => fieldLabels[String(part)]) ?? location[0];
      return description ? `${field ? `${fieldLabels[String(field)] ?? String(field).replaceAll("_", " ")}: ` : ""}${description}` : null;
    }
    return null;
  };
  return message(body) ?? `The request could not be completed (${status}). Please try again.`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(apiErrorMessage(body, response.status));
  }
  return response.json() as Promise<T>;
}

export const api = {
  config: () => request<Record<string, unknown>>("/api/v1/config"),
  sampleConfig: () => request<Record<string, unknown>>("/api/v1/sample-map/config"),
  regions: (partition: Partition) =>
    request<{ partition: Partition; regions: RegionSummary[] }>(`/api/v1/regions?partition=${partition}`),
  evaluation: (partition: Partition, groupId: string, index: IndexName, direction: HarmonizationDirection, signal?: AbortSignal) =>
    request<EvaluationResponse>(`/api/v1/evaluations/${partition}/${encodeURIComponent(groupId)}?index=${index}&direction=${direction}`, { signal }),
  childEcoregions: (partition: Partition, groupId: string, signal?: AbortSignal) =>
    request<{ regions: NestedEcoregion[] }>(`/api/v1/region-guide/${partition}/${encodeURIComponent(groupId)}/children`, { signal }),
  nestedEvaluation: (parent: EvaluationResponse, child: NestedEcoregion, signal?: AbortSignal) => {
    const query = new URLSearchParams({ index: parent.index, direction: parent.direction,
      coefficient_partition: parent.partition, coefficient_group_id: parent.group_id });
    return request<EvaluationResponse>(`/api/v1/evaluations/${child.partition}/${encodeURIComponent(child.id)}?${query}`, { signal });
  },
  randomPoint: (partition: Partition, groupId: string) =>
    request<{ point: { longitude: number; latitude: number }; zoom: number }>(
      `/api/v1/regions/${partition}/${encodeURIComponent(groupId)}/random-point`,
    ),
  locationSearch: (query: string, partition: Partition, groupId: string, signal?: AbortSignal) =>
    request<{ query: string; results: LocationSearchResult[]; provider: string }>(
      `/api/v1/location-search?q=${encodeURIComponent(query)}&partition=${partition}&group_id=${encodeURIComponent(groupId)}`,
      { signal },
    ),
  maps: (config: AnalysisConfig, signal?: AbortSignal) =>
    request<MapTiles>("/api/v1/maps", { method: "POST", body: JSON.stringify(config), signal }),
  timeseries: (
    config: AnalysisConfig,
    longitude: number,
    latitude: number,
    includeHarmonizedSensors: boolean,
    signal?: AbortSignal,
  ) =>
    request<TimeseriesResponse>("/api/v1/timeseries", {
      method: "POST",
      body: JSON.stringify({
        ...config,
        longitude,
        latitude,
        include_harmonized_sensors: includeHarmonizedSensors,
      }),
      signal,
    }),
  polygonAnalysis: (config: AnalysisConfig, coordinates: number[][], signal?: AbortSignal) =>
    request<PolygonAnalysisResponse>("/api/v1/polygon-analysis", {
      method: "POST",
      body: JSON.stringify({
        ...config,
        geometry: { type: "Polygon", coordinates: [coordinates] },
      }),
      signal,
    }),
  sampleFeatures: (body: Record<string, unknown>, signal?: AbortSignal) =>
    request<GeoJsonFeatureCollection>("/api/v1/sample-map/features", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  coefficients: (partition: string, method: string, index: string, direction: HarmonizationDirection, groupId?: string) => {
    const params = new URLSearchParams({ partition, method, index, direction });
    if (groupId) params.set("group_id", groupId);
    return request<Record<string, unknown>>(`/api/v1/coefficients?${params}`);
  },
};
