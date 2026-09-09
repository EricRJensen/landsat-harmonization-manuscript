from __future__ import annotations

from pathlib import Path
from typing import Any

import ee
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .coefficients import CoefficientError, get_coefficient_store
from .ee_pipeline import EarthEngineConfigurationError
from .geocoding import search_photon
from .published_coefficients import ROY_2016_ID, roy_models
from .region_membership import get_region_boundary_store
from .sample_store import get_sample_store
from .schemas import AnalysisRequest, HarmonizationDirection, IndexName, Method, Partition, PolygonAnalysisRequest, SampleQuery, TimeseriesRequest
from .service import format_polygon_analysis, format_timeseries, get_pipeline
from .settings import get_settings

settings = get_settings()
api = FastAPI(title=settings.app_name, version=__version__)
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
) -> dict[str, Any]:
    try:
        if partition == "nlcd":
            raise HTTPException(status_code=400, detail="NLCD is not an empirical region selector")
        store = get_coefficient_store()
        region = store.region(partition, group_id)
        scored = store.evaluation(partition, group_id, index, direction)
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
            sources.append((partition, str(group_id), "regional"))
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


@api.post("/api/v1/maps")
async def maps(request: AnalysisRequest) -> dict[str, Any]:
    try:
        pipeline = get_pipeline()
        result = await run_in_threadpool(
            pipeline.map_tiles,
            request.partition,
            request.method,
            request.index,
            request.direction,
            request.start_year,
            request.end_year,
            request.significant_only,
            (
                request.bbox.west,
                request.bbox.south,
                request.bbox.east,
                request.bbox.north,
            )
            if request.bbox
            else None,
            request.coefficient_partition,
            request.coefficient_group_id,
        )
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


@api.post("/api/v1/timeseries")
async def timeseries(request: TimeseriesRequest) -> dict[str, Any]:
    try:
        pipeline = get_pipeline()
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
        pipeline = get_pipeline()
        coordinates = tuple(
            (float(longitude), float(latitude))
            for longitude, latitude in request.geometry.coordinates[0]
        )
        payload = await run_in_threadpool(
            pipeline.polygon_analysis,
            request.partition,
            request.method,
            request.index,
            request.direction,
            request.start_year,
            request.end_year,
            coordinates,
            request.coefficient_partition,
            request.coefficient_group_id,
        )
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


@api.get("/")
def root() -> Any:
    index = settings.frontend_dist / "index.html"
    if index.is_file():
        return FileResponse(index)
    return {"name": settings.app_name, "docs": "/docs", "frontend": "Run npm run dev in app/frontend"}


if settings.frontend_dist.is_dir():
    assets = settings.frontend_dist / "assets"
    if assets.is_dir():
        api.mount("/assets", StaticFiles(directory=assets), name="frontend-assets")

    @api.get("/{path:path}")
    def frontend_fallback(path: str) -> FileResponse:
        candidate = settings.frontend_dist / path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(settings.frontend_dist / "index.html")


def run() -> None:
    import uvicorn

    uvicorn.run("harmonization_api.main:api", host="127.0.0.1", port=8000, reload=True)
