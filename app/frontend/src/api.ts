import type { AnalysisConfig, EvaluationResponse, GeoJsonFeatureCollection, HarmonizationDirection, IndexName, LocationSearchResult, MapBounds, MapTiles, Partition, PolygonAnalysisResponse, RegionSummary, TimeseriesResponse } from "./types";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(body.detail ?? `Request failed (${response.status})`);
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
  randomPoint: (partition: Partition, groupId: string) =>
    request<{ point: { longitude: number; latitude: number }; zoom: number }>(
      `/api/v1/regions/${partition}/${encodeURIComponent(groupId)}/random-point`,
    ),
  locationSearch: (query: string, partition: Partition, groupId: string, signal?: AbortSignal) =>
    request<{ query: string; results: LocationSearchResult[]; provider: string }>(
      `/api/v1/location-search?q=${encodeURIComponent(query)}&partition=${partition}&group_id=${encodeURIComponent(groupId)}`,
      { signal },
    ),
  maps: (config: AnalysisConfig, bbox: MapBounds, signal?: AbortSignal) =>
    request<MapTiles>("/api/v1/maps", { method: "POST", body: JSON.stringify({ ...config, bbox }), signal }),
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
