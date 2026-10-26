import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";

// Solid edges mark placed vertices; dashed edges preview the next point and closure.
export function sketchData(coordinates: number[][], cursor: number[] | null = null, closed = false): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = coordinates.map((coordinate, index) => ({
    type: "Feature", properties: { kind: "vertex", first: index === 0 }, geometry: { type: "Point", coordinates: coordinate },
  }));
  if (coordinates.length >= 2) features.unshift({
    type: "Feature", properties: { kind: "edge" },
    geometry: { type: "LineString", coordinates: closed ? [...coordinates, coordinates[0]] : coordinates },
  });
  const atFirst = cursor && coordinates.length >= 3 && cursor[0] === coordinates[0][0] && cursor[1] === coordinates[0][1];
  const outline = cursor && !closed && !atFirst ? [...coordinates, cursor] : coordinates;
  if (outline.length >= 3) features.unshift({
    type: "Feature", properties: { kind: "area" },
    geometry: { type: "Polygon", coordinates: [[...outline, outline[0]]] },
  });
  if (!closed && coordinates.length && (cursor || coordinates.length >= 3)) {
    const preview = [coordinates[coordinates.length - 1]];
    if (cursor) preview.push(cursor);
    if (!atFirst && coordinates.length >= (cursor ? 2 : 3)) preview.push(coordinates[0]);
    features.push({ type: "Feature", properties: { kind: "preview" }, geometry: { type: "LineString", coordinates: preview } });
  }
  return { type: "FeatureCollection", features };
}

export function installSketch(map: MapLibreMap, coordinates: number[][], cursor: number[] | null = null, closed = false) {
  const layerIds = ["analysis-sketch-fill", "analysis-sketch-casing", "analysis-sketch-line", "analysis-sketch-preview", "analysis-sketch-points"];
  const data = sketchData(coordinates, cursor, closed);
  const source = map.getSource("analysis-sketch") as GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    layerIds.forEach((id) => { if (map.getLayer(id)) map.moveLayer(id); });
    return;
  }
  map.addSource("analysis-sketch", { type: "geojson", data });
  map.addLayer({
    id: "analysis-sketch-fill", type: "fill", source: "analysis-sketch",
    filter: ["==", ["get", "kind"], "area"],
    paint: { "fill-color": "#756bb1", "fill-opacity": 0.2 },
  });
  map.addLayer({
    id: "analysis-sketch-casing", type: "line", source: "analysis-sketch",
    filter: ["in", ["get", "kind"], ["literal", ["edge", "preview"]]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "analysis-sketch-line", type: "line", source: "analysis-sketch",
    filter: ["==", ["get", "kind"], "edge"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#5c5291", "line-width": 4 },
  });
  map.addLayer({
    id: "analysis-sketch-preview", type: "line", source: "analysis-sketch",
    filter: ["==", ["get", "kind"], "preview"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#5c5291", "line-width": 4, "line-dasharray": [2, 2] },
  });
  map.addLayer({
    id: "analysis-sketch-points", type: "circle", source: "analysis-sketch",
    filter: ["==", ["get", "kind"], "vertex"],
    paint: { "circle-radius": ["case", ["get", "first"], 9, 6], "circle-color": "#756bb1", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
  });
}
