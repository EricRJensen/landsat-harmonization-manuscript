import type { AnalysisConfig, MapBounds, PolygonDraft } from "./types";

// The significance checkbox affects map rendering, not the polygon calculation.
export function scientificIdentity(config: AnalysisConfig): string {
  return JSON.stringify([config.partition, config.method, config.index, config.direction,
    config.start_year, config.end_year, config.coefficient_partition, config.coefficient_group_id]);
}
export function polygonIdentity(polygon: PolygonDraft, config: AnalysisConfig): string {
  return JSON.stringify([scientificIdentity(config), polygon.closed, polygon.vertices]);
}
export function mapIdentity(config: AnalysisConfig): string {
  return JSON.stringify([scientificIdentity(config), config.significant_only]);
}
export function boundsError(bounds: MapBounds | null): string | null {
  if (!bounds || !Object.values(bounds).every(Number.isFinite)) return "Wait for the map location to finish moving.";
  if (bounds.east <= bounds.west || bounds.north <= bounds.south) return "Choose a location within the conterminous U.S.";
  return null;
}
// A response may only commit while its generation is still the latest request.
export class RequestGeneration {
  private generation = 0;
  next(): number { return ++this.generation; }
  isCurrent(value: number): boolean { return value === this.generation; }
}
