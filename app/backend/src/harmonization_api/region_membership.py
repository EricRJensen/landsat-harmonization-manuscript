from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .schemas import Partition
from .settings import get_settings


ECOREGION_FIELDS = {
    "ecoregion_l1": "NA_L1CODE",
    "ecoregion_l2": "NA_L2CODE",
    "ecoregion_l3": "US_L3CODE",
}


def _ring_contains(ring: list[list[float]], longitude: float, latitude: float) -> bool:
    inside = False
    previous_x, previous_y = ring[-1][:2]
    for coordinate in ring:
        current_x, current_y = coordinate[:2]
        if ((current_y > latitude) != (previous_y > latitude)) and (
            longitude
            < (previous_x - current_x) * (latitude - current_y)
            / (previous_y - current_y) + current_x
        ):
            inside = not inside
        previous_x, previous_y = current_x, current_y
    return inside


def _polygon_contains(rings: list[list[list[float]]], longitude: float, latitude: float) -> bool:
    return bool(rings) and _ring_contains(rings[0], longitude, latitude) and not any(
        _ring_contains(hole, longitude, latitude) for hole in rings[1:]
    )


def _geometry_contains(geometry: dict[str, Any], longitude: float, latitude: float) -> bool:
    coordinates = geometry.get("coordinates", [])
    if geometry.get("type") == "Polygon":
        return _polygon_contains(coordinates, longitude, latitude)
    if geometry.get("type") == "MultiPolygon":
        return any(_polygon_contains(polygon, longitude, latitude) for polygon in coordinates)
    return False


class RegionBoundaryStore:
    def __init__(self, directory: Path):
        self.directory = directory
        self._features: dict[str, list[dict[str, Any]]] = {}

    def _load(self, filename: str) -> list[dict[str, Any]]:
        if filename not in self._features:
            path = self.directory / filename
            if not path.is_file():
                raise FileNotFoundError(f"Region boundary artifact not found: {path}")
            with path.open(encoding="utf-8") as source:
                self._features[filename] = json.load(source).get("features", [])
        return self._features[filename]

    def contains(self, partition: Partition, group_id: str, longitude: float, latitude: float) -> bool:
        if partition == "conus":
            return True
        if partition == "nlcd":
            return False
        if partition == "huc02":
            filename, field = "huc02.geojson", "huc2"
        else:
            filename, field = "ecoregions.geojson", ECOREGION_FIELDS[partition]
        expected = str(group_id).strip()
        for feature in self._load(filename):
            if str(feature.get("properties", {}).get(field, "")).strip() != expected:
                continue
            if _geometry_contains(feature.get("geometry", {}), longitude, latitude):
                return True
        return False


@lru_cache
def get_region_boundary_store() -> RegionBoundaryStore:
    return RegionBoundaryStore(get_settings().region_boundary_dir)
