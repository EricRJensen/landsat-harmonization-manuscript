from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import ee
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from . import __version__
from .coefficients import CoefficientError, get_coefficient_store
from .ee_pipeline import EarthEngineConfigurationError
from .frontend import mount_frontend
from .geocoding import search_photon
from .published_coefficients import ROY_2016_ID, roy_models
from .region_membership import get_region_boundary_store
from .region_guide import router as region_guide_router
from .sample_store import get_sample_store
from .nested_evaluation import get_nested_evaluation_store
from .schemas import AnalysisRequest, HarmonizationDirection, IndexName, Method, Partition, PolygonAnalysisRequest, SampleQuery, TimeseriesRequest
from .service import format_polygon_analysis, format_timeseries, get_pipeline
from .settings import get_settings
from .trend_tiles import decode_scenario, descriptors, tile_url
from .work_cache import WorkCache

_pipeline_work = WorkCache(workers=1, capacity=1, ttl=3600, name="ee-init")
_polygon_work = WorkCache(workers=2, capacity=32, ttl=1800, name="ee-area")

settings = get_settings()
api = FastAPI(title=settings.app_name, version=__version__)
api.include_router(region_guide_router)
api.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def translate_error(error: Exception) -> HTTPException:
    if isinstance(error, (CoefficientError, EarthEngineConfigurationError, FileNotFoundError)):
        return HTTPException(status_code=503, detail=str(error))
    if isinstance(error, ee.EEException):
        if "too many pixels" in str(error).lower():
            counts = re.search(r"Found\s+([\d,]+).*?allows only\s+([\d,]+)", str(error), re.IGNORECASE)
            size = ""
            if counts:
                required, limit = (int(value.replace(",", "")) for value in counts.groups())
                size = f" This area requires {required:,} pixels; the limit is {limit:,} pixels per reduction."
            return HTTPException(status_code=413, detail=(
                "Your area of interest is too large to analyze at the current resolution."
                + size + " Edit the boundary in B to select a smaller area, or analyze it in separate sections. "
                "Time series use 30 m pixels and trend summaries use 90 m pixels; resolution is not reduced automatically."
            ))
        return HTTPException(status_code=502, detail=f"Earth Engine error: {error}")
    return HTTPException(status_code=500, detail=str(error))


@api.get("/api/v1/config")
def config() -> dict[str, Any]:
    try:
        artifact = get_coefficient_store()
        provenance = artifact.metadata
        groups = {
            direction: {partition: len(values) for partition, values in partitions.items()}
            for direction, partitions in artifact.data["models"].items()
        }
    except Exception as error:
        provenance = {"error": str(error)}
        groups = {}
    return {
        "name": settings.app_name,
        "indices": ["NDVI", "EVI", "MSAVI"],
        "methods": ["band_linear", "band_cubic", "index_linear", "index_cubic"],
        "directions": ["L7_to_L8", "L8_to_L7"],
        "partitions": ["conus", "ecoregion_l1", "ecoregion_l2", "ecoregion_l3", "huc02", "nlcd"],
        "year_min": 1985,
        "year_max": 2025,
        "minimum_period_years": 8,
        "defaults": {
            "index": "NDVI",
            "method": "band_linear",
            "direction": "L7_to_L8",
            "partition": "conus",
            "start_year": 1985,
            "end_year": 2025,
        },
        "coefficient_provenance": provenance,
        "coefficient_group_counts": groups,
    }


@api.get("/api/v1/regions")
def regions(partition: Partition = Query(...)) -> dict[str, Any]:
    try:
        if partition == "nlcd":
            raise HTTPException(status_code=400, detail="NLCD is not an empirical region selector")
        store = get_coefficient_store()
        return {
            "partition": partition,
            "regions": [
                {key: value for key, value in item.items() if key != "candidates"}
                for item in store.regions(partition)
            ],
            "provenance": store.metadata,
        }
    except HTTPException:
        raise
    except Exception as error:
        raise translate_error(error) from error


def _models_for_choice(
    store: Any,
    partition: str,
    group_id: str,
    method: str,
    index: str,
    direction: str,
) -> dict[str, Any] | None:
    group = store.groups(partition, direction).get(group_id)
    if group is None:
        return None
    family, degree_name = method.split("_")
    degree = "1" if degree_name == "linear" else "3"
    models = group.get(family, {}).get(degree, {})
    if family == "index":
        model = models.get(index)
        return {index: model} if model else None
    return models if len(models) == 6 else None


@api.get("/api/v1/evaluations/{partition}/{group_id}")
def evaluations(
    partition: Partition,
    group_id: str,
    index: IndexName = "NDVI",
    direction: HarmonizationDirection = "L7_to_L8",
    coefficient_partition: Partition | None = None,
    coefficient_group_id: str | None = None,
) -> dict[str, Any]:
    try:
        if partition == "nlcd":
            raise HTTPException(status_code=400, detail="NLCD is not an empirical region selector")
        store = get_coefficient_store()
        if (coefficient_partition is None) != (coefficient_group_id is None):
            raise HTTPException(status_code=400, detail="Specify both the coefficient region type and identifier.")
        if coefficient_partition is not None:
            if coefficient_partition not in ("ecoregion_l1", "ecoregion_l2"):
                raise HTTPException(status_code=400, detail="Choose Level I or Level II coefficients for a nested evaluation.")
            descendants = get_region_boundary_store().descendants(coefficient_partition, coefficient_group_id)
            if group_id not in descendants.get(partition, set()):
                raise HTTPException(status_code=400, detail="The evaluation ecoregion must be within the selected coefficient ecoregion.")
        region = store.region(partition, group_id)
        regional_partition = coefficient_partition or partition
        regional_group = coefficient_group_id if coefficient_group_id is not None else group_id
        coefficient_region = store.region(regional_partition, regional_group)
        scored = (get_nested_evaluation_store().evaluate(
            regional_partition, regional_group, partition, group_id, index, direction,
        ) if coefficient_partition is not None else store.evaluation(partition, group_id, index, direction))
        alternatives: list[dict[str, Any]] = [
            {
                "id": "unharmonized", "source": "raw", "method": None,
                "available": "unharmonized" in scored, "metrics": scored.get("unharmonized"),
                "models": None,
            }
        ]
        alternatives.append(
            {
                "id": ROY_2016_ID,
                "source": "published",
                "method": None,
                "available": ROY_2016_ID in scored,
                "metrics": scored.get(ROY_2016_ID),
                "models": roy_models(direction),
                "citation": "Roy et al. (2016)",
                "regression_type": "OLS",
            }
        )
        sources = [("conus", "CONUS", "CONUS")]
        if partition != "conus":
            sources.append((regional_partition, str(regional_group), "regional"))
        for model_partition, model_group, label in sources:
            for method in ("band_linear", "band_cubic", "index_linear", "index_cubic"):
                alternative_id = f"{model_partition}_{method}"
                models = _models_for_choice(
                    store, model_partition, model_group, method, index, direction
                )
                metrics = scored.get(alternative_id)
                alternatives.append(
                    {
                        "id": alternative_id,
                        "source": label,
                        "coefficient_partition": model_partition,
                        "coefficient_group_id": model_group,
                        "method": method,
                        "available": models is not None and metrics is not None,
                        "metrics": metrics,
                        "models": models,
                    }
                )
        return {
            "partition": partition,
            "group_id": region["id"],
            "group_name": region["name"],
            "sample_count": region["sample_count"],
            "coefficient_region": {"partition": regional_partition, "id": coefficient_region["id"], "name": coefficient_region["name"]},
            "index": index,
            "direction": direction,
            "source_sensor": "L7" if direction == "L7_to_L8" else "L8",
            "target_sensor": "L8" if direction == "L7_to_L8" else "L7",
            "mean_bias": store.metadata["directions"][direction]["mean_difference"],
            "mean_difference": store.metadata["directions"][direction]["mean_difference"],
            "fallback_to_conus": False,
            "alternatives": alternatives,
            "provenance": store.metadata,
        }
    except HTTPException:
        raise
    except Exception as error:
        raise translate_error(error) from error


@api.get("/api/v1/regions/{partition}/{group_id}/random-point")
def random_region_point(partition: Partition, group_id: str) -> dict[str, Any]:
    try:
        if partition == "nlcd":
            raise HTTPException(status_code=400, detail="NLCD has no empirical candidate pool")
        store = get_coefficient_store()
        return {
            "partition": partition,
            "group_id": "CONUS" if partition == "conus" else group_id,
            "point": store.random_point(partition, group_id),
            "zoom": 10,
            "source_checksum": store.metadata.get("source", {}).get("sha256"),
        }
    except HTTPException:
        raise
    except Exception as error:
        raise translate_error(error) from error


@api.get("/api/v1/location-search")
async def location_search(
    q: str = Query(..., min_length=3, max_length=100),
    partition: Partition = "conus",
    group_id: str = "CONUS",
) -> dict[str, Any]:
    """Search named places and addresses within CONUS using Photon/OSM."""
    try:
        results = await search_photon(q.strip())
        boundaries = get_region_boundary_store()
        for result in results:
            result["inside_selected_region"] = boundaries.contains(
                partition, group_id, result["longitude"], result["latitude"]
            )
        return {
            "query": q,
            "partition": partition,
            "group_id": group_id,
            "results": results,
            "provider": "Photon / OpenStreetMap",
        }
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Location search is temporarily unavailable") from error


@api.get("/api/v1/coefficients")
def coefficients(
    partition: Partition = "conus",
    group_id: str | None = None,
    method: Method = "band_linear",
    index: IndexName = "NDVI",
    direction: HarmonizationDirection = "L7_to_L8",
) -> dict[str, Any]:
    try:
        store = get_coefficient_store()
        group, fallback = store.group(partition, group_id, direction)
        family, degree_name = method.split("_")
        degree = "1" if degree_name == "linear" else "3"
        metrics = group[family][degree]
        if family == "index":
            metrics = {index: metrics[index]}
        return {
            "partition": partition,
            "requested_group": group_id,
            "group_name": group["name"],
            "fallback_to_conus": fallback,
            "method": method,
            "direction": direction,
            "models": metrics,
            "offset_direction": (
                "L7 transformed to L8-equivalent"
                if direction == "L7_to_L8"
                else "L8 transformed to L7-equivalent"
            ),
        }
    except Exception as error:
        raise translate_error(error) from error


async def ready_pipeline():
    # EE initialization makes network calls; never perform them on the event loop.
    return await _pipeline_work.get((get_pipeline,), get_pipeline)


@api.post("/api/v1/maps")
async def maps(request: AnalysisRequest) -> dict[str, Any]:
    try:
        # Validate configuration now; geographic map IDs are prepared lazily as
        # the browser requests tiles, independently of the initial viewport.
        await ready_pipeline()
        if request.coefficient_partition:
            get_coefficient_store().empirical_group(
                request.coefficient_partition, request.coefficient_group_id or "CONUS", request.direction
            )
        result = descriptors(request)
        result["coefficient_selection"] = {
            "partition": request.coefficient_partition,
            "group_id": request.coefficient_group_id,
            "direction": request.direction,
            "fallback_to_conus": False if request.coefficient_partition else None,
        }
        result["provenance"] = get_coefficient_store().metadata
        return result
    except Exception as error:
        raise translate_error(error) from error


@api.get("/api/v1/trend-tiles/{scenario}/{layer}/{z}/{x}/{y}.png")
async def trend_tile(scenario: str, layer: str, z: int, x: int, y: int):
    try:
        request = decode_scenario(scenario)
        url = await tile_url(await ready_pipeline(), request, layer, z, x, y)
        # Serve images on the app origin. Redirected EE tile responses can omit
        # CORS headers in browsers even when the image itself is available.
        async with httpx.AsyncClient(timeout=180) as client:
            upstream = await client.get(url)
        content_type = upstream.headers.get("content-type", "").split(";", 1)[0]
        if upstream.status_code != 200 or not content_type.startswith("image/"):
            raise HTTPException(status_code=502, detail="Earth Engine could not render this trend tile. Please try again.")
        return Response(upstream.content, media_type=content_type,
                        headers={"Cache-Control": "public, max-age=3600"})
    except HTTPException:
        raise
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Earth Engine trend tile request failed. Please try again.") from error
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail="Invalid trend tile request.") from error
    except Exception as error:
        raise translate_error(error) from error


@api.post("/api/v1/timeseries")
async def timeseries(request: TimeseriesRequest) -> dict[str, Any]:
    try:
        pipeline = await ready_pipeline()
        rows = await run_in_threadpool(
            pipeline.time_series,
            request.partition,
            request.method,
            request.index,
            request.direction,
            request.start_year,
            request.end_year,
            request.longitude,
            request.latitude,
            request.coefficient_partition,
            request.coefficient_group_id,
        )
        result = format_timeseries(rows, request.include_harmonized_sensors)
        strata = await run_in_threadpool(
            pipeline.point_strata,
            request.partition,
            request.start_year,
            request.end_year,
            request.longitude,
            request.latitude,
        )
        result["point"] = {"longitude": request.longitude, "latitude": request.latitude}
        result["strata"] = strata
        result["coefficient_selection"] = {
            "partition": request.coefficient_partition,
            "group_id": request.coefficient_group_id,
            "direction": request.direction,
            "fallback_to_conus": False if request.coefficient_partition else None,
        }
        result["provenance"] = get_coefficient_store().metadata
        return result
    except Exception as error:
        raise translate_error(error) from error


@api.post("/api/v1/polygon-analysis")
async def polygon_analysis(request: PolygonAnalysisRequest) -> dict[str, Any]:
    try:
        pipeline = await ready_pipeline()
        coordinates = tuple(
            (float(longitude), float(latitude))
            for longitude, latitude in request.geometry.coordinates[0]
        )
        args = (
            request.partition, request.method, request.index, request.direction,
            request.start_year, request.end_year, coordinates,
            request.coefficient_partition, request.coefficient_group_id,
        )
        payload = await _polygon_work.get((pipeline, *args), lambda: pipeline.polygon_analysis(*args))
        result = format_polygon_analysis(payload)
        result["geometry"] = request.geometry.model_dump()
        result["units"] = f"{request.index} per decade"
        result["coefficient_selection"] = {
            "partition": request.coefficient_partition,
            "group_id": request.coefficient_group_id,
            "direction": request.direction,
            "fallback_to_conus": False if request.coefficient_partition else None,
        }
        result["provenance"] = get_coefficient_store().metadata
        return result
    except Exception as error:
        raise translate_error(error) from error


@api.get("/api/v1/sample-map/config")
async def sample_map_config() -> dict[str, Any]:
    try:
        return await run_in_threadpool(get_sample_store().config)
    except Exception as error:
        raise translate_error(error) from error


@api.post("/api/v1/sample-map/features")
async def sample_map_features(request: SampleQuery) -> dict[str, Any]:
    try:
        return await run_in_threadpool(
            get_sample_store().query, request, settings.sample_point_limit
        )
    except Exception as error:
        raise translate_error(error) from error


@api.get("/api/v1/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "coefficient_artifact": settings.coefficient_artifact.is_file(),
        "sample_parquet": settings.sample_parquet.startswith(("http://", "https://", "gs://"))
        or Path(settings.sample_parquet).is_file(),
        "earth_engine_configured": bool(settings.ee_project),
        "spatial_assets": {
            "ecoregions": bool(settings.ecoregion_asset),
            "huc02": bool(settings.huc02_asset),
        },
    }


mount_frontend(api, settings.frontend_dist, settings.app_name)


def run() -> None:
    import uvicorn

    uvicorn.run("harmonization_api.main:api", host="127.0.0.1", port=8000, reload=True)
