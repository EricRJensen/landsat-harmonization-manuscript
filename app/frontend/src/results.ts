import type { PolygonAnalysisResponse, TrendDistribution } from "./types";

export function formatResultValue(value: number | null | undefined, digits = 4): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not available";
  if (value !== 0 && Math.abs(value) < 10 ** -digits) return value.toExponential(2);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

/** The area-mean API returns slopes per year; pixel summaries already use per decade. */
export function areaMeanSlopePerDecade(slope: number | null | undefined): number | null {
  return typeof slope === "number" && Number.isFinite(slope) ? slope * 10 : null;
}

export function significantPixelPercentage(distribution: TrendDistribution | undefined, direction: "decrease" | "increase"): number | null {
  if (!distribution || !Number.isFinite(distribution.pixel_count) || distribution.pixel_count <= 0) return null;
  const keys = direction === "decrease" ? ["-3", "-2"] as const : ["3", "2"] as const;
  const values = keys.map((key) => distribution.class_percentages?.[key]);
  return values.every((value) => typeof value === "number" && Number.isFinite(value))
    ? values.reduce((sum, value) => sum + value, 0) : null;
}

/** Spherical polygon area in km², for a descriptive area label, not analysis. */
export function polygonAreaSquareKm(geometry: PolygonAnalysisResponse["geometry"]): number | null {
  if (!geometry?.coordinates?.length) return null;
  const radius = 6371.0088;
  const radians = Math.PI / 180;
  let total = 0;
  for (const [ringIndex, ring] of geometry.coordinates.entries()) {
    if (ring.length < 3 || ring.some((point) => point.length < 2 || !point.every(Number.isFinite))) return null;
    let integral = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[(i + 1) % ring.length];
      const longitudeChange = ((lon2 - lon1 + 540) % 360) - 180;
      integral += longitudeChange * radians * (2 + Math.sin(lat1 * radians) + Math.sin(lat2 * radians));
    }
    const area = Math.abs(integral * radius ** 2 / 2);
    total += ringIndex === 0 ? area : -area;
  }
  return total >= 0 ? total : null;
}
