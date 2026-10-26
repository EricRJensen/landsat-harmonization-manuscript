"""Continuous XYZ browsing with bounded, shared Earth Engine computation graphs.

A source filter covers the entire fixed XYZ block, so every requested pixel
includes all intersecting scenes. It is independent of the initial viewport and
of the evaluation region. No spatial mask is applied to the trend image.
"""
from __future__ import annotations

import base64
import json
import math
from typing import Any

from .schemas import AnalysisRequest
from .work_cache import WorkCache

MIN_ZOOM = 7
MAX_ZOOM = 13
BLOCK_ZOOM = 7
TTL_SECONDS = 2 * 60 * 60
_work = WorkCache(workers=2, capacity=192, ttl=TTL_SECONDS, name="ee-map")


def layer_request(request: AnalysisRequest, layer: str) -> AnalysisRequest:
    if layer != "raw":
        return request
    # Raw imagery does not depend on the fitted coefficients or reference sensor.
    return request.model_copy(update={"partition": "conus", "method": "band_linear", "direction": "L7_to_L8",
                                      "coefficient_partition": None, "coefficient_group_id": None})


def scenario_token(request: AnalysisRequest) -> str:
    data = request.model_dump(exclude={"bbox"})
    return base64.urlsafe_b64encode(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")


def decode_scenario(token: str) -> AnalysisRequest:
    if len(token) > 2048:
        raise ValueError("Invalid trend configuration")
    return AnalysisRequest.model_validate_json(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    n = 2 ** z
    latitude = lambda row: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * row / n))))
    return x / n * 360 - 180, latitude(y + 1), (x + 1) / n * 360 - 180, latitude(y)


def descriptors(request: AnalysisRequest) -> dict[str, Any]:
    return {
        **{layer: {
            "url": f"/api/v1/trend-tiles/{scenario_token(layer_request(request, layer))}/{layer}/{{z}}/{{x}}/{{y}}.png?v=2",
            "min": -limit, "max": limit,
            "palette": ["#b2182b", "#f7f7f7", "#2166ac"],
            "minzoom": MIN_ZOOM, "maxzoom": MAX_ZOOM,
        } for layer, limit in (("raw", .05), ("harmonized", .05), ("difference", .03))},
        "units": f"{request.index} per decade",
        "fixed_coefficients": request.coefficient_partition is not None,
    }


async def tile_url(pipeline: Any, request: AnalysisRequest, layer: str, z: int, x: int, y: int) -> str:
    if layer not in ("raw", "harmonized", "difference") or not MIN_ZOOM <= z <= MAX_ZOOM or not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise ValueError("Invalid trend tile coordinate")
    request = layer_request(request, layer)
    block_x, block_y = x >> (z - BLOCK_ZOOM), y >> (z - BLOCK_ZOOM)
    key = (pipeline, scenario_token(request), layer, block_x, block_y)
    # Duplicate tile waiters share a future rather than filling the API's
    # worker pool with threads blocked on locks. Only two map builds run at once.
    tiles = await _work.get(key, lambda: pipeline.map_tiles(
        request.partition, request.method, request.index, request.direction,
        request.start_year, request.end_year, request.significant_only,
        tile_bounds(BLOCK_ZOOM, block_x, block_y),
        request.coefficient_partition, request.coefficient_group_id,
        layers=(layer,),
    ))
    return tiles[layer]["url"].replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
