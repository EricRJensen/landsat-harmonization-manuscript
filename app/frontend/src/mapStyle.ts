import type { StyleSpecification } from "maplibre-gl";
import type { BasemapMode } from "./types";

export const LABEL_LAYER_ID = "place-labels";

export function baseStyle(mode: BasemapMode): StyleSpecification {
  if (mode === "streets") {
    return {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors",
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "osm" }],
    };
  }
  return {
    version: 8,
    sources: {
      imagery: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
      },
      labels: {
        type: "raster",
        tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community",
      },
    },
    layers: [
      { id: "basemap", type: "raster", source: "imagery" },
      { id: LABEL_LAYER_ID, type: "raster", source: "labels" },
    ],
  };
}
