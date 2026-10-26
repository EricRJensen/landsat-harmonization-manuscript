import type { Partition } from "./types";

export interface RegionGuideBoundaries {
  type: "FeatureCollection";
  partition: Partition;
  display_only: boolean;
  features: Array<{
    properties: { group_id: string; name: string };
    geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
  }>;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : "Region guidance is unavailable. Choose a region by name instead.");
  }
  return response.json();
}

export const regionGuideApi = {
  overlay: (partition: Partition, groupId: string, signal?: AbortSignal) =>
    get<GeoJSON.FeatureCollection>(`/api/v1/region-guide/${partition}/${encodeURIComponent(groupId)}/overlay`, signal),
  lookup: (partition: Partition, longitude: number, latitude: number, signal?: AbortSignal) =>
    get<{ regions: Array<{ id: string; name: string }> }>(`/api/v1/region-guide/${partition}/lookup?longitude=${longitude}&latitude=${latitude}`, signal),
  boundaries: (partition: Partition, signal?: AbortSignal) => get<RegionGuideBoundaries>(`/api/v1/region-guide/${partition}/boundaries`, signal),
};
