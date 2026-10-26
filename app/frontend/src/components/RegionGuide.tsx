import { useEffect, useId, useState } from "react";
import { regionGuideApi, type RegionGuideBoundaries } from "../regionGuideApi";
import type { Partition } from "../types";

function boundaryPath(coordinates: number[][][][]) {
  return coordinates.flatMap((polygon) => polygon.map((ring) => ring.map(([longitude, latitude], i) => `${i ? "L" : "M"}${((longitude + 125) * 10 + 15).toFixed(1)},${((50 - latitude) * 12.5 + 15).toFixed(1)}`).join(" ") + " Z")).join(" ");
}

export function RegionGuide({ partition, groupId, groupName }: {
  partition: Partition; groupId: string; groupName?: string;
}) {
  const [boundaries, setBoundaries] = useState<RegionGuideBoundaries | null>(null);
  const [previewError, setPreviewError] = useState("");
  const previewId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setBoundaries(null); setPreviewError("");
    regionGuideApi.boundaries(partition, controller.signal).then(setBoundaries).catch((reason: Error) => {
      if (reason.name !== "AbortError") setPreviewError(reason.message);
    });
    return () => controller.abort();
  }, [partition]);

  return <div className="region-guide">
    {boundaries ? <figure className="region-boundary-preview">
      <svg viewBox="0 0 620 355" role="img" aria-labelledby={previewId}>
        <title id={previewId}>{groupName ? `${groupName} highlighted within the study regions` : "Study regions in the conterminous United States; choose a region to highlight it"}</title>
        <rect width="620" height="355" fill="#f8faf7" />
        {boundaries.features.map((feature, i) => <path key={i} d={boundaryPath(feature.geometry.coordinates)} fillRule="evenodd"
          fill={feature.properties.group_id === groupId ? "#1d6652" : "#e0e9e2"}
          stroke={partition === "huc02" || partition === "ecoregion_l3" ? "#81968a" : feature.properties.group_id === groupId ? "#1d6652" : "#e0e9e2"} strokeWidth="0.6" />)}
      </svg>
      <figcaption>{groupName ? <><span className="region-preview-key" />{groupName}</> : "Choose a region above."}<small>Boundary preview for orientation.</small></figcaption>
    </figure> : <p className="region-guide-feedback" role="status">{previewError || "Loading region boundaries…"}</p>}
  </div>;
}
