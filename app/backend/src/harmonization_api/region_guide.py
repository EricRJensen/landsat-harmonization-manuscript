"""Read-only geographic guidance for choosing an empirical evaluation region."""
from __future__ import annotations

from functools import lru_cache
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from .coefficients import get_coefficient_store
from .region_membership import get_region_boundary_store
from .schemas import Partition

router = APIRouter(prefix="/api/v1/region-guide")


@router.get("/{partition}/{group_id}/children")
def child_regions(partition: Partition, group_id: str) -> dict[str, Any]:
    if partition not in ("ecoregion_l1", "ecoregion_l2"):
        raise HTTPException(status_code=400, detail="Choose a Level I or Level II parent ecoregion.")
    store = get_coefficient_store()
    if not any(region["id"] == group_id for region in store.regions(partition)):
        raise HTTPException(status_code=404, detail="Parent ecoregion not found.")
    try:
        descendants = get_region_boundary_store().descendants(partition, group_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail="Ecoregion hierarchy is unavailable.") from error
    return {"regions": [
        {"partition": level, "id": region["id"], "name": region["name"]}
        for level, codes in descendants.items()
        for region in store.regions(level) if region["id"] in codes
    ]}


def _supported(partition: Partition) -> None:
    if partition in ("conus", "nlcd"):
        raise HTTPException(status_code=400, detail="Choose an ecoregion level or HUC02 watershed for region lookup.")


def _simplify_line(points: list[list[float]], tolerance: float = 0.025) -> list[list[float]]:
    """Douglas–Peucker geometry for a small orientation preview only."""
    if len(points) <= 3:
        return points
    first, last = points[0], points[-1]
    dx, dy = last[0] - first[0], last[1] - first[1]
    length_squared = dx * dx + dy * dy
    max_distance, split = 0.0, 0
    for i in range(1, len(points) - 1):
        point = points[i]
        t = max(0.0, min(1.0, ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / length_squared)) if length_squared else 0.0
        distance = (point[0] - first[0] - t * dx) ** 2 + (point[1] - first[1] - t * dy) ** 2
        if distance > max_distance:
            max_distance, split = distance, i
    if max_distance <= tolerance ** 2:
        return [first, last]
    return _simplify_line(points[:split + 1], tolerance)[:-1] + _simplify_line(points[split:], tolerance)


def _preview_geometry(geometry: dict[str, Any]) -> dict[str, Any]:
    def ring(points: list[list[float]]) -> list[list[float]]:
        simplified = _simplify_line(points)
        # Keep tiny islands valid, including their closing vertex.
        return [[round(value, 5) for value in point[:2]] for point in (simplified if len(simplified) >= 4 else points)]

    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    coordinates = [[ring(points) for points in polygon] for polygon in polygons]
    return {"type": "MultiPolygon", "coordinates": coordinates}


@lru_cache(maxsize=4)
def _preview(partition: Partition) -> dict[str, Any]:
    catalog = {region["id"]: region["name"] for region in get_coefficient_store().regions(partition)}
    features = []
    for feature in get_region_boundary_store().region_features(partition):
        group_id = feature["properties"]["group_id"]
        if group_id not in catalog:
            continue
        features.append({
            "type": "Feature",
            "properties": {"group_id": group_id, "name": catalog[group_id]},
            "geometry": _preview_geometry(feature["geometry"]),
        })
    return {"type": "FeatureCollection", "partition": partition, "features": features, "display_only": True}


@router.get("/{partition}/boundaries")
def region_boundaries(partition: Partition) -> dict[str, Any]:
    _supported(partition)
    try:
        return _preview(partition)
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail="Region boundary preview is unavailable. You can still select a region by name.") from error


@router.get("/{partition}/lookup")
def lookup_region(
    partition: Partition,
    longitude: float = Query(..., ge=-180, le=180),
    latitude: float = Query(..., ge=-90, le=90),
) -> dict[str, Any]:
    _supported(partition)
    try:
        matches = set(get_region_boundary_store().locate(partition, longitude, latitude))
        return {
            "partition": partition,
            "longitude": longitude,
            "latitude": latitude,
            "regions": [
                {key: value for key, value in region.items() if key != "candidates"}
                for region in get_coefficient_store().regions(partition)
                if region["id"] in matches
            ],
        }
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail="Region lookup is unavailable. Select a region by name instead.") from error


@lru_cache(maxsize=128)
def _evaluation_overlay(partition: Partition, group_id: str) -> dict[str, Any]:
    """Dissolve shared borders before constructing a display-only inverse polygon."""
    from shapely import make_valid
    from shapely.geometry import box, mapping, shape
    from shapely.ops import unary_union

    catalog = {region["id"] for region in get_coefficient_store().regions(partition)}
    if group_id not in catalog:
        raise HTTPException(status_code=404, detail="Evaluation region not found.")
    source_partition = "ecoregion_l1" if partition == "conus" else partition
    geometries = [
        make_valid(shape(feature["geometry"]))
        for feature in get_region_boundary_store().region_features(source_partition)
        if partition == "conus" or feature["properties"]["group_id"] == group_id
    ]
    if not geometries:
        raise HTTPException(status_code=404, detail="Evaluation region boundary unavailable.")
    region = unary_union(geometries)
    outside = box(-180, -85.051129, 180, 85.051129).difference(region)
    return {
        "type": "FeatureCollection", "display_only": True,
        "features": [
            {"type": "Feature", "properties": {"role": "outside"}, "geometry": mapping(outside)},
            {"type": "Feature", "properties": {"role": "boundary"}, "geometry": mapping(region.boundary)},
        ],
    }


@router.get("/{partition}/{group_id}/overlay")
def evaluation_overlay(partition: Partition, group_id: str) -> dict[str, Any]:
    if partition == "nlcd":
        raise HTTPException(status_code=400, detail="Land-cover classes do not define an evaluation-region boundary.")
    try:
        return _evaluation_overlay(partition, group_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=503, detail="Evaluation region boundary unavailable.") from error
