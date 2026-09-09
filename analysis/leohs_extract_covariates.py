

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
from pathlib import Path
from typing import Any, Iterator, Sequence


DEFAULT_PROJECT = "climate-engine-pro"
DEFAULT_INPUT_CSV = Path("data/external/SR_Landsatsamples.csv")
DEFAULT_WORK_DIR = Path("output/covariates")
DEFAULT_COMBINED_EXPORT_CSV = Path(
    "output/covariates/Covariates.csv"
)
DEFAULT_LOCAL_COVARIATE_PARQUET = Path(
    "output/covariates/Local_Covariates.parquet"
)
DEFAULT_POINTS_PARQUET = Path(
    "output/covariates/Points.parquet"
)
DEFAULT_GEE_COVARIATE_PARQUET = Path(
    "output/covariates/GEE_Covariates.parquet"
)
DEFAULT_SAMPLE_PARQUET = Path(
    "output/covariates/SR_Landsatsamples.parquet"
)
DEFAULT_SAMPLE_COVARIATE_PARQUET = Path(
    "output/covariates/SR_Landsatsamples_covariates.parquet"
)
DEFAULT_STATE_SHP = Path("data/external/cb_2018_us_state_5m.shp")
DEFAULT_ECOREGION_SHP = Path("data/external/us_eco_l3.shp")
DEFAULT_HUC02_SHP = Path("data/external/huc02_conus.shp")
DEFAULT_SAGEBRUSH_SHP = Path("data/external/US_Sagebrush_Biome_2019.shp")
DEFAULT_GEOMETRY_COLUMN = "geometry"
DEFAULT_ID_COLUMN = "leohs_id"
WORKFLOW_SCHEMA_VERSION = 2
SHARD_SIZE_DEGREES = 2
POINT_KEY_DIGEST_CHARS = 24
COORDINATE_QUANTUM = Decimal("0.000000000001")
ELEVATION_ASSET = "USGS/3DEP/10m_collection"
NLCD_ASSET = "projects/sat-io/open-datasets/USGS/ANNUAL_NLCD/LANDCOVER"
NLCD_START_YEAR = 2013
NLCD_END_YEAR = 2021
NLCD_YEARS = tuple(range(NLCD_START_YEAR, NLCD_END_YEAR + 1))
ELEVATION_OUTPUT = "elevation_m"
SAMPLE_YEAR_OUTPUT = "sample_year"
NLCD_OUTPUT = "nlcd_landcover"
NLCD_BANDS = tuple(f"nlcd_{year}" for year in NLCD_YEARS)
LOCAL_COVARIATE_COLUMNS = (
    "state_name",
    "state_abbr",
    "ecoregion_l1_name",
    "ecoregion_l1_id",
    "ecoregion_l2_name",
    "ecoregion_l2_id",
    "ecoregion_l3_name",
    "ecoregion_l3_id",
    "huc02_name",
    "huc02_id",
    "in_sagebrush_biome",
)
LANDSAT_IMAGE_COLUMNS = ("L7_image_id", "L8_image_id")
ACTIVE_STATES = {"READY", "RUNNING"}
LANDSAT_DATE_RE = re.compile(r"_(\d{8})$")
WKT_POINT_RE = re.compile(
    r"^\s*POINT\s*\(\s*"
    r"([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)"
    r"\s+"
    r"([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)"
    r"\s*\)\s*$",
    re.IGNORECASE,
)


class CovariateError(RuntimeError):
    """A user-facing workflow or validation error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_wkt_point(value: str) -> tuple[Decimal, Decimal]:
    """Parse a WKT POINT and validate WGS84 longitude/latitude bounds."""
    match = WKT_POINT_RE.match(value or "")
    if not match:
        raise CovariateError(f"Invalid WKT POINT: {value!r}")
    try:
        longitude = Decimal(match.group(1))
        latitude = Decimal(match.group(2))
    except InvalidOperation as exc:
        raise CovariateError(f"Invalid coordinate in WKT POINT: {value!r}") from exc
    if not longitude.is_finite() or not latitude.is_finite():
        raise CovariateError(f"Non-finite coordinate in WKT POINT: {value!r}")
    if longitude < -180 or longitude > 180:
        raise CovariateError(f"Longitude outside [-180, 180]: {longitude}")
    if latitude < -90 or latitude > 90:
        raise CovariateError(f"Latitude outside [-90, 90]: {latitude}")
    return longitude, latitude


def canonical_coordinate(value: Decimal) -> str:
    """Return a coordinate rounded to a stable 12-decimal fixed-point string."""
    quantized = value.quantize(COORDINATE_QUANTUM, rounding=ROUND_HALF_EVEN)
    if quantized == 0:
        quantized = abs(quantized)
    return format(quantized, "f")


def canonical_location(longitude: Decimal, latitude: Decimal) -> tuple[str, str]:
    return canonical_coordinate(longitude), canonical_coordinate(latitude)


def landsat_acquisition_year(image_id: str, column_name: str) -> int:
    """Extract and validate the acquisition year from a Landsat image ID."""
    match = LANDSAT_DATE_RE.search((image_id or "").strip())
    if not match:
        raise CovariateError(
            f"{column_name!r} does not end with a YYYYMMDD acquisition date: {image_id!r}"
        )
    acquisition_date = match.group(1)
    try:
        year = datetime.strptime(acquisition_date, "%Y%m%d").year
    except ValueError as exc:
        raise CovariateError(
            f"{column_name!r} ends with an invalid acquisition date: {image_id!r}"
        ) from exc
    if year not in NLCD_YEARS:
        raise CovariateError(
            f"{column_name!r} acquisition year {year} is outside the available "
            f"NLCD years {NLCD_START_YEAR}-{NLCD_END_YEAR}"
        )
    return year


def point_key(
    canonical_longitude: str,
    canonical_latitude: str,
    digest_chars: int = POINT_KEY_DIGEST_CHARS,
) -> str:
    payload = f"{canonical_longitude},{canonical_latitude}".encode("ascii")
    return hashlib.sha256(payload).hexdigest()[:digest_chars]


def shard_for_point(longitude: Decimal, latitude: Decimal) -> tuple[int, int, int]:
    """Return numeric shard ID and global 2-degree grid indexes."""
    lon_index = min(
        179, max(0, math.floor((float(longitude) + 180.0) / SHARD_SIZE_DEGREES))
    )
    lat_index = min(
        89, max(0, math.floor((float(latitude) + 90.0) / SHARD_SIZE_DEGREES))
    )
    return lat_index * 180 + lon_index, lon_index, lat_index


def shard_bounds(lon_index: int, lat_index: int) -> tuple[int, int, int, int]:
    lon_min = -180 + lon_index * SHARD_SIZE_DEGREES
    lat_min = -90 + lat_index * SHARD_SIZE_DEGREES
    return (
        lon_min,
        lat_min,
        lon_min + SHARD_SIZE_DEGREES,
        lat_min + SHARD_SIZE_DEGREES,
    )


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def shapefile_provenance(path: Path) -> dict[str, Any]:
    """Fingerprint the geometry, attributes, index, and CRS used by a shapefile."""
    components: dict[str, dict[str, Any]] = {}
    for suffix in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
        component = path.with_suffix(suffix)
        if component.is_file():
            components[component.name] = {
                "size_bytes": component.stat().st_size,
                "sha256": sha256_file(component),
            }
    return {
        "path": str(path),
        "status": "available" if path.is_file() else "missing",
        "components": components,
    }


def state_path(work_dir: Path) -> Path:
    return work_dir / "state.sqlite"


def stage_path(work_dir: Path) -> Path:
    return work_dir / "points.csv"


def manifest_path(work_dir: Path) -> Path:
    return work_dir / "manifest.json"


def result_path(work_dir: Path) -> Path:
    return work_dir / "covariates.csv"


def connect_state(work_dir: Path, require: bool = True) -> sqlite3.Connection:
    path = state_path(work_dir)
    if require and not path.exists():
        raise CovariateError(f"State database does not exist: {path}. Run prepare first.")
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


def create_schema(connection: sqlite3.Connection) -> None:
    nlcd_columns = ",\n".join(f"            {band} TEXT" for band in NLCD_BANDS)
    connection.executescript(
        f"""
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE points (
            point_key TEXT PRIMARY KEY,
            canonical_longitude TEXT NOT NULL,
            canonical_latitude TEXT NOT NULL,
            longitude REAL NOT NULL,
            latitude REAL NOT NULL,
            shard_id INTEGER NOT NULL,
            UNIQUE(canonical_longitude, canonical_latitude)
        );
        CREATE INDEX points_shard_id_idx ON points(shard_id);
        CREATE TABLE source_rows (
            source_row INTEGER PRIMARY KEY,
            leohs_id TEXT NOT NULL UNIQUE,
            point_key TEXT NOT NULL REFERENCES points(point_key),
            sample_year INTEGER NOT NULL
        );
        CREATE INDEX source_rows_leohs_id_idx ON source_rows(leohs_id);
        CREATE INDEX source_rows_point_key_idx ON source_rows(point_key);
        CREATE TABLE shards (
            shard_id INTEGER PRIMARY KEY,
            lon_index INTEGER NOT NULL,
            lat_index INTEGER NOT NULL,
            lon_min INTEGER NOT NULL,
            lat_min INTEGER NOT NULL,
            lon_max INTEGER NOT NULL,
            lat_max INTEGER NOT NULL,
            point_count INTEGER NOT NULL
        );
        CREATE TABLE tasks (
            shard_id INTEGER NOT NULL REFERENCES shards(shard_id),
            attempt INTEGER NOT NULL,
            task_id TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL,
            output_prefix TEXT NOT NULL,
            error_message TEXT,
            submitted_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(shard_id, attempt)
        );
        CREATE TABLE results (
            point_key TEXT PRIMARY KEY REFERENCES points(point_key),
            elevation_m TEXT,
{nlcd_columns},
            shard_id INTEGER NOT NULL
        );
        """
    )


def set_metadata(connection: sqlite3.Connection, key: str, value: Any) -> None:
    encoded = json.dumps(value, sort_keys=True)
    connection.execute(
        """
        INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (key, encoded),
    )


def get_metadata(
    connection: sqlite3.Connection, key: str, default: Any = None
) -> Any:
    row = connection.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def require_current_schema(connection: sqlite3.Connection) -> None:
    version = get_metadata(connection, "workflow_schema_version")
    if version != WORKFLOW_SCHEMA_VERSION:
        raise CovariateError(
            "Prepared state is incompatible with the annual NLCD workflow. "
            "Run prepare with a fresh --work-dir, GCS prefix, and Earth Engine asset."
        )


def register_point(
    connection: sqlite3.Connection,
    key: str,
    canonical_longitude: str,
    canonical_latitude: str,
    shard_id: int,
) -> bool:
    """Insert a point and explicitly reject a truncated-hash collision."""
    cursor = connection.execute(
        """
        INSERT OR IGNORE INTO points(
            point_key, canonical_longitude, canonical_latitude,
            longitude, latitude, shard_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            key,
            canonical_longitude,
            canonical_latitude,
            float(canonical_longitude),
            float(canonical_latitude),
            shard_id,
        ),
    )
    if cursor.rowcount:
        return True
    existing = connection.execute(
        """
        SELECT canonical_longitude, canonical_latitude
        FROM points WHERE point_key = ?
        """,
        (key,),
    ).fetchone()
    if existing is None:
        # The location exists under another key, which indicates inconsistent state.
        existing = connection.execute(
            """
            SELECT point_key FROM points
            WHERE canonical_longitude = ? AND canonical_latitude = ?
            """,
            (canonical_longitude, canonical_latitude),
        ).fetchone()
        raise CovariateError(
            f"Location already registered under a different key: {dict(existing or {})}"
        )
    if (
        existing["canonical_longitude"] != canonical_longitude
        or existing["canonical_latitude"] != canonical_latitude
    ):
        raise CovariateError(
            "Point-key collision detected for "
            f"{key}: ({existing['canonical_longitude']}, "
            f"{existing['canonical_latitude']}) vs "
            f"({canonical_longitude}, {canonical_latitude})"
        )
    return False


def prepare(args: argparse.Namespace) -> None:
    input_csv = Path(args.input_csv).resolve()
    work_dir = Path(args.work_dir).resolve()
    if not input_csv.is_file():
        raise CovariateError(f"Input CSV does not exist: {input_csv}")
    work_dir.mkdir(parents=True, exist_ok=True)
    state = state_path(work_dir)
    staged = stage_path(work_dir)
    if (state.exists() or staged.exists()) and not args.force:
        raise CovariateError(
            f"Prepared files already exist in {work_dir}. Use --force to rebuild them."
        )

    temporary_state = state.with_suffix(".sqlite.tmp")
    temporary_stage = staged.with_suffix(".csv.tmp")
    for path in (temporary_state, temporary_stage):
        path.unlink(missing_ok=True)

    input_sha256 = sha256_file(input_csv)
    connection = sqlite3.connect(temporary_state)
    connection.row_factory = sqlite3.Row
    create_schema(connection)
    shard_counts: Counter[tuple[int, int, int]] = Counter()
    sample_year_counts: Counter[int] = Counter()
    source_count = 0
    unique_count = 0

    try:
        with input_csv.open("r", newline="", encoding="utf-8") as source, temporary_stage.open(
            "w", newline="", encoding="utf-8"
        ) as destination:
            reader = csv.DictReader(source)
            required_columns = {
                args.geometry_column,
                DEFAULT_ID_COLUMN,
                *LANDSAT_IMAGE_COLUMNS,
            }
            missing_columns = required_columns - set(reader.fieldnames or [])
            if missing_columns:
                raise CovariateError(
                    f"Required columns are not present in {input_csv}: "
                    f"{sorted(missing_columns)}"
                )
            writer = csv.writer(destination, lineterminator="\n")
            writer.writerow(["point_key", "longitude", "latitude", "shard_id"])
            for source_row, row in enumerate(reader):
                try:
                    longitude, latitude = parse_wkt_point(row[args.geometry_column])
                except CovariateError as exc:
                    raise CovariateError(f"Source row {source_row}: {exc}") from exc
                canonical_lon, canonical_lat = canonical_location(longitude, latitude)
                key = point_key(canonical_lon, canonical_lat)
                sample_id = row[DEFAULT_ID_COLUMN].strip()
                if not sample_id:
                    raise CovariateError(
                        f"Source row {source_row}: {DEFAULT_ID_COLUMN!r} is empty"
                    )
                try:
                    l7_year = landsat_acquisition_year(
                        row["L7_image_id"], "L7_image_id"
                    )
                    l8_year = landsat_acquisition_year(
                        row["L8_image_id"], "L8_image_id"
                    )
                except CovariateError as exc:
                    raise CovariateError(f"Source row {source_row}: {exc}") from exc
                if l7_year != l8_year:
                    raise CovariateError(
                        f"Source row {source_row}: Landsat acquisition years differ "
                        f"(L7={l7_year}, L8={l8_year})"
                    )
                sample_year = l7_year
                shard_id, lon_index, lat_index = shard_for_point(longitude, latitude)
                inserted = register_point(
                    connection, key, canonical_lon, canonical_lat, shard_id
                )
                if inserted:
                    writer.writerow([key, canonical_lon, canonical_lat, shard_id])
                    shard_counts[(shard_id, lon_index, lat_index)] += 1
                    unique_count += 1
                try:
                    connection.execute(
                        """
                        INSERT INTO source_rows(
                            source_row, leohs_id, point_key, sample_year
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (source_row, sample_id, key, sample_year),
                    )
                except sqlite3.IntegrityError as exc:
                    raise CovariateError(
                        f"Duplicate {DEFAULT_ID_COLUMN!r} at source row "
                        f"{source_row}: {sample_id}"
                    ) from exc
                source_count += 1
                sample_year_counts[sample_year] += 1
                if source_count % 50_000 == 0:
                    connection.commit()

        for (shard_id, lon_index, lat_index), count in sorted(shard_counts.items()):
            bounds = shard_bounds(lon_index, lat_index)
            connection.execute(
                """
                INSERT INTO shards(
                    shard_id, lon_index, lat_index, lon_min, lat_min,
                    lon_max, lat_max, point_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (shard_id, lon_index, lat_index, *bounds, count),
            )
        set_metadata(connection, "prepared_at", utc_now())
        set_metadata(connection, "workflow_schema_version", WORKFLOW_SCHEMA_VERSION)
        set_metadata(connection, "input_csv", str(input_csv))
        set_metadata(connection, "input_sha256", input_sha256)
        set_metadata(connection, "geometry_column", args.geometry_column)
        set_metadata(connection, "id_column", DEFAULT_ID_COLUMN)
        set_metadata(connection, "source_row_count", source_count)
        set_metadata(connection, "unique_point_count", unique_count)
        set_metadata(connection, "duplicate_point_count", source_count - unique_count)
        set_metadata(connection, "sample_year_counts", dict(sorted(sample_year_counts.items())))
        set_metadata(connection, "shard_count", len(shard_counts))
        set_metadata(connection, "shard_size_degrees", SHARD_SIZE_DEGREES)
        set_metadata(connection, "point_key_digest_chars", POINT_KEY_DIGEST_CHARS)
        set_metadata(connection, "coordinate_decimal_places", 12)
        connection.commit()
    except Exception:
        connection.close()
        temporary_state.unlink(missing_ok=True)
        temporary_stage.unlink(missing_ok=True)
        raise
    else:
        connection.close()

    if args.force:
        for path in (
            state,
            staged,
            Path(f"{state}-wal"),
            Path(f"{state}-shm"),
        ):
            path.unlink(missing_ok=True)
    os.replace(temporary_state, state)
    os.replace(temporary_stage, staged)
    connection = connect_state(work_dir)
    try:
        write_manifest(connection, work_dir)
    finally:
        connection.close()
    print(
        f"Prepared {source_count:,} rows, {unique_count:,} unique points, "
        f"and {len(shard_counts):,} occupied shards in {work_dir}"
    )


def normalize_gcs_prefix(prefix: str) -> str:
    return prefix.strip("/")


def configure_cloud(
    connection: sqlite3.Connection,
    project: str,
    bucket: str,
    gcs_prefix: str,
    asset_id: str,
) -> None:
    require_current_schema(connection)
    if not normalize_gcs_prefix(gcs_prefix):
        raise CovariateError("--gcs-prefix must not be empty.")
    requested = {
        "project": project,
        "bucket": bucket.removeprefix("gs://").strip("/"),
        "gcs_prefix": normalize_gcs_prefix(gcs_prefix),
        "asset_id": asset_id,
    }
    existing = get_metadata(connection, "cloud_config")
    if existing and existing != requested:
        raise CovariateError(
            "Cloud arguments differ from the persisted configuration. "
            f"Existing={existing}, requested={requested}"
        )
    set_metadata(connection, "cloud_config", requested)
    connection.commit()


def initialize_ee(project: str) -> Any:
    try:
        import ee
    except ImportError as exc:
        raise CovariateError("The earthengine-api package is required.") from exc
    ee.Initialize(project=project)
    return ee


def storage_client(project: str) -> Any:
    try:
        from google.cloud import storage
    except ImportError as exc:
        raise CovariateError("The google-cloud-storage package is required.") from exc
    return storage.Client(project=project)


def task_error(status: dict[str, Any]) -> str | None:
    return status.get("error_message") or status.get("errorMessage")


def get_asset_if_exists(ee: Any, asset_id: str) -> dict[str, Any] | None:
    try:
        return ee.data.getAsset(asset_id)
    except Exception:
        return None


def refresh_ingestion(connection: sqlite3.Connection, ee: Any) -> None:
    task_id = get_metadata(connection, "ingest_task_id")
    if task_id:
        status = ee.data.getTaskStatus(task_id)[0]
        set_metadata(connection, "ingest_task_state", status.get("state", "UNKNOWN"))
        set_metadata(connection, "ingest_task_error", task_error(status))
        set_metadata(connection, "ingest_task_updated_at", utc_now())
    cloud_config = get_metadata(connection, "cloud_config", {})
    ingest_state = get_metadata(connection, "ingest_task_state")
    if ingest_state == "COMPLETED" and cloud_config.get("asset_id"):
        asset_metadata = get_asset_if_exists(ee, cloud_config["asset_id"])
        if asset_metadata:
            set_metadata(connection, "point_asset_metadata", asset_metadata)
        else:
            set_metadata(connection, "ingest_task_state", "MISSING")
            set_metadata(connection, "point_asset_metadata", None)
            set_metadata(
                connection,
                "ingest_task_error",
                "The completed ingestion asset no longer exists or is inaccessible.",
            )
    connection.commit()


def refresh_export_tasks(connection: sqlite3.Connection, ee: Any) -> None:
    rows = connection.execute(
        "SELECT shard_id, attempt, task_id FROM tasks WHERE state NOT IN ('COMPLETED')"
    ).fetchall()
    now = utc_now()
    for row in rows:
        status = ee.data.getTaskStatus(row["task_id"])[0]
        connection.execute(
            """
            UPDATE tasks SET state = ?, error_message = ?, updated_at = ?
            WHERE shard_id = ? AND attempt = ?
            """,
            (
                status.get("state", "UNKNOWN"),
                task_error(status),
                now,
                row["shard_id"],
                row["attempt"],
            ),
        )
    connection.commit()


def ingest(args: argparse.Namespace) -> None:
    work_dir = Path(args.work_dir).resolve()
    connection = connect_state(work_dir)
    try:
        configure_cloud(
            connection, args.project, args.bucket, args.gcs_prefix, args.asset_id
        )
        ee = initialize_ee(args.project)
        refresh_ingestion(connection, ee)
        ingest_state = get_metadata(connection, "ingest_task_state")
        if ingest_state in ACTIVE_STATES:
            print(
                f"Ingestion task {get_metadata(connection, 'ingest_task_id')} "
                f"is already {ingest_state}"
            )
            return
        asset_metadata = get_asset_if_exists(ee, args.asset_id)
        if asset_metadata and not args.overwrite:
            set_metadata(connection, "point_asset_metadata", asset_metadata)
            set_metadata(connection, "ingest_task_state", "COMPLETED")
            connection.commit()
            write_manifest(connection, work_dir)
            print(f"Point asset already exists: {args.asset_id}")
            return
        if ingest_state == "COMPLETED":
            set_metadata(connection, "ingest_task_state", "MISSING")
            set_metadata(connection, "point_asset_metadata", None)
            connection.commit()

        bucket_name = args.bucket.removeprefix("gs://").strip("/")
        object_name = f"{normalize_gcs_prefix(args.gcs_prefix)}/inputs/points.csv"
        client = storage_client(args.project)
        blob = client.bucket(bucket_name).blob(object_name)
        blob.upload_from_filename(stage_path(work_dir), content_type="text/csv")
        gcs_uri = f"gs://{bucket_name}/{object_name}"
        request_id = ee.data.newTaskId()[0]
        table_manifest = {
            "name": args.asset_id,
            "sources": [
                {
                    "uris": [gcs_uri],
                    "charset": "UTF-8",
                    "crs": "EPSG:4326",
                    "xColumn": "longitude",
                    "yColumn": "latitude",
                }
            ],
            "properties": {
                "input_sha256": get_metadata(connection, "input_sha256"),
                "prepared_at": get_metadata(connection, "prepared_at"),
            },
        }
        result = ee.data.startTableIngestion(
            request_id, table_manifest, allow_overwrite=args.overwrite
        )
        set_metadata(connection, "staged_points_gcs_uri", gcs_uri)
        set_metadata(connection, "ingest_task_id", result["id"])
        set_metadata(connection, "ingest_task_state", "READY")
        set_metadata(connection, "ingest_task_submitted_at", utc_now())
        connection.commit()
        write_manifest(connection, work_dir)
        print(f"Submitted point-table ingestion task {result['id']} from {gcs_uri}")
    finally:
        connection.close()


def build_covariate_collection(
    ee: Any, points: Any, tile_scale: int = 4
) -> tuple[Any, dict[str, Any]]:
    """Build the sequential native-grid reductions for one point collection."""
    elevation_collection = ee.ImageCollection(ELEVATION_ASSET)
    elevation = elevation_collection.mosaic().select("elevation")
    elevation_projection = ee.Image(elevation_collection.first()).select(
        "elevation"
    ).projection()
    with_elevation = elevation.reduceRegions(
        collection=points,
        reducer=ee.Reducer.first().setOutputs([ELEVATION_OUTPUT]),
        crs=elevation_projection,
        tileScale=tile_scale,
    )

    nlcd_collection = (
        ee.ImageCollection(NLCD_ASSET)
        .filter(ee.Filter.gte("year", NLCD_START_YEAR))
        .filter(ee.Filter.lte("year", NLCD_END_YEAR))
        .select("b1")
    )
    nlcd = ee.Image.cat(
        [
            ee.Image(nlcd_collection.filter(ee.Filter.eq("year", year)).first()).rename(
                f"nlcd_{year}"
            )
            for year in NLCD_YEARS
        ]
    )
    nlcd_projection = ee.Image(nlcd_collection.first()).select("b1").projection()
    output = nlcd.reduceRegions(
        collection=with_elevation,
        reducer=ee.Reducer.first(),
        crs=nlcd_projection,
        tileScale=tile_scale,
    )
    return output, {
        "elevation_collection": elevation_collection,
        "nlcd_collection": nlcd_collection,
    }


def latest_tasks(connection: sqlite3.Connection) -> dict[int, sqlite3.Row]:
    rows = connection.execute(
        """
        SELECT t.* FROM tasks t
        JOIN (
            SELECT shard_id, MAX(attempt) AS attempt
            FROM tasks GROUP BY shard_id
        ) latest USING(shard_id, attempt)
        """
    ).fetchall()
    return {row["shard_id"]: row for row in rows}


def submit(args: argparse.Namespace) -> None:
    work_dir = Path(args.work_dir).resolve()
    connection = connect_state(work_dir)
    try:
        configure_cloud(
            connection, args.project, args.bucket, args.gcs_prefix, args.asset_id
        )
        if args.max_active < 1:
            raise CovariateError("--max-active must be at least 1.")
        if args.tile_scale < 1:
            raise CovariateError("--tile-scale must be at least 1.")
        if args.resubmit_completed and not args.shard_id:
            raise CovariateError(
                "--resubmit-completed requires at least one --shard-id."
            )
        ee = initialize_ee(args.project)
        refresh_ingestion(connection, ee)
        if get_metadata(connection, "ingest_task_state") != "COMPLETED":
            raise CovariateError(
                "Point-table ingestion is not completed. Run status and retry submit later."
            )
        refresh_export_tasks(connection, ee)
        asset_metadata = ee.data.getAsset(args.asset_id)
        set_metadata(connection, "point_asset_metadata", asset_metadata)
        set_metadata(
            connection,
            "covariate_asset_metadata",
            {
                ELEVATION_ASSET: ee.data.getAsset(ELEVATION_ASSET),
                NLCD_ASSET: ee.data.getAsset(NLCD_ASSET),
            },
        )
        nlcd_years = (
            ee.ImageCollection(NLCD_ASSET)
            .filter(ee.Filter.gte("year", NLCD_START_YEAR))
            .filter(ee.Filter.lte("year", NLCD_END_YEAR))
            .aggregate_array("year")
            .getInfo()
        )
        nlcd_years = sorted({int(year) for year in nlcd_years})
        if nlcd_years != list(NLCD_YEARS):
            raise CovariateError(
                f"NLCD collection years differ from the expected 2013-2021 set: "
                f"{nlcd_years}"
            )
        set_metadata(connection, "selected_nlcd_years", nlcd_years)
        set_metadata(connection, "elevation_asset", ELEVATION_ASSET)
        set_metadata(connection, "nlcd_asset", NLCD_ASSET)
        set_metadata(connection, "tile_scale", args.tile_scale)
        connection.commit()

        selected_shards = set(args.shard_id or [])
        shards = connection.execute("SELECT * FROM shards ORDER BY shard_id").fetchall()
        if selected_shards:
            missing = selected_shards - {row["shard_id"] for row in shards}
            if missing:
                raise CovariateError(f"Unknown shard IDs: {sorted(missing)}")
            shards = [row for row in shards if row["shard_id"] in selected_shards]

        latest = latest_tasks(connection)
        active_count = connection.execute(
            "SELECT COUNT(*) AS count FROM tasks WHERE state IN ('READY', 'RUNNING')"
        ).fetchone()["count"]
        submitted = 0
        bucket_name = args.bucket.removeprefix("gs://").strip("/")
        base_prefix = normalize_gcs_prefix(args.gcs_prefix)
        point_asset = ee.FeatureCollection(args.asset_id)

        for shard in shards:
            if active_count >= args.max_active:
                break
            previous = latest.get(shard["shard_id"])
            if (
                previous
                and previous["state"] == "COMPLETED"
                and not args.resubmit_completed
            ):
                continue
            if previous and previous["state"] in ACTIVE_STATES:
                continue
            if (
                previous
                and previous["state"] != "COMPLETED"
                and not args.retry_failed
            ):
                continue
            attempt = (previous["attempt"] + 1) if previous else 1
            # The ingested geometry can shift slightly across a grid boundary.
            # shard_id is authoritative and already limits each task spatially.
            points = point_asset.filter(ee.Filter.eq("shard_id", shard["shard_id"]))
            output, _ = build_covariate_collection(ee, points, tile_scale=args.tile_scale)
            output_prefix = (
                f"{base_prefix}/exports/shard_{shard['shard_id']:05d}/"
                f"attempt_{attempt:03d}/part"
            )
            description = f"covariates_s{shard['shard_id']:05d}_a{attempt:03d}"
            task = ee.batch.Export.table.toCloudStorage(
                collection=output,
                description=description,
                bucket=bucket_name,
                fileNamePrefix=output_prefix,
                fileFormat="CSV",
                selectors=["point_key", ELEVATION_OUTPUT, *NLCD_BANDS],
            )
            task.start()
            now = utc_now()
            connection.execute(
                """
                INSERT INTO tasks(
                    shard_id, attempt, task_id, state, output_prefix,
                    error_message, submitted_at, updated_at
                ) VALUES (?, ?, ?, 'READY', ?, NULL, ?, ?)
                """,
                (shard["shard_id"], attempt, task.id, output_prefix, now, now),
            )
            submitted += 1
            active_count += 1
            connection.commit()
        write_manifest(connection, work_dir)
        print(
            f"Submitted {submitted} export task(s); "
            f"{active_count} task(s) are READY or RUNNING"
        )
    finally:
        connection.close()


def status(args: argparse.Namespace) -> None:
    work_dir = Path(args.work_dir).resolve()
    connection = connect_state(work_dir)
    try:
        require_current_schema(connection)
        ee = initialize_ee(args.project)
        refresh_ingestion(connection, ee)
        refresh_export_tasks(connection, ee)
        ingest_state = get_metadata(connection, "ingest_task_state", "NOT_SUBMITTED")
        task_counts = {
            row["state"]: row["count"]
            for row in connection.execute(
                "SELECT state, COUNT(*) AS count FROM tasks GROUP BY state ORDER BY state"
            )
        }
        completed_shards = connection.execute(
            "SELECT COUNT(DISTINCT shard_id) AS count FROM tasks WHERE state = 'COMPLETED'"
        ).fetchone()["count"]
        total_shards = get_metadata(connection, "shard_count", 0)
        write_manifest(connection, work_dir)
        print(f"Ingestion: {ingest_state}")
        print(f"Export task states: {task_counts or {}}")
        print(f"Completed shards: {completed_shards}/{total_shards}")
        failures = connection.execute(
            """
            SELECT shard_id, attempt, state, error_message FROM tasks
            WHERE state IN ('FAILED', 'CANCELLED') ORDER BY shard_id, attempt
            """
        ).fetchall()
        for failure in failures:
            print(
                f"FAILED shard={failure['shard_id']} attempt={failure['attempt']}: "
                f"{failure['error_message'] or failure['state']}"
            )
    finally:
        connection.close()


def iter_blob_csv_rows(blob: Any) -> Iterator[dict[str, str]]:
    with blob.open("r", encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        required = {"point_key", ELEVATION_OUTPUT, *NLCD_BANDS}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise CovariateError(
                f"Export {blob.name} is missing required columns: {sorted(missing)}"
            )
        yield from reader


def nlcd_case_expression(
    sample_alias: str = "sr", result_alias: str = "r"
) -> str:
    cases = " ".join(
        f"WHEN {year} THEN {result_alias}.nlcd_{year}" for year in NLCD_YEARS
    )
    return f"CASE {sample_alias}.sample_year {cases} END"


def resolve_layer_field(
    columns: Sequence[str],
    requested: str | None,
    candidates: Sequence[str],
    label: str,
) -> str:
    if requested:
        if requested not in columns:
            raise CovariateError(
                f"Requested {label} field {requested!r} is not present. "
                f"Available fields: {sorted(columns)}"
            )
        return requested
    lower_names = {name.lower(): name for name in columns}
    for candidate in candidates:
        if candidate.lower() in lower_names:
            return lower_names[candidate.lower()]
    raise CovariateError(
        f"Could not identify the {label} field. Available fields: {sorted(columns)}. "
        f"Specify it explicitly."
    )


def sql_string(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def sql_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def duckdb_vector_fields(connection: Any, path: Path) -> list[str]:
    return [
        row[0]
        for row in connection.execute(
            f"DESCRIBE SELECT * FROM ST_Read({sql_string(path)})"
        ).fetchall()
    ]


def create_duckdb_polygon_table(
    connection: Any,
    table_name: str,
    path: Path,
    fields: dict[str, str],
) -> None:
    if not path.is_file():
        raise CovariateError(f"Required vector file does not exist: {path}")
    available = duckdb_vector_fields(connection, path)
    missing = set(fields.values()) - set(available)
    if missing:
        raise CovariateError(
            f"Vector file is missing fields {sorted(missing)}: {path}. "
            f"Available fields: {sorted(available)}"
        )
    projections = [
        f"{sql_identifier(source)}::VARCHAR AS {sql_identifier(output)}"
        for output, source in fields.items()
    ]
    projections.extend(
        [
            "OGC_FID::BIGINT AS feature_order",
            "ST_Transform(geom, 'EPSG:4326', always_xy := true) AS geom",
        ]
    )
    connection.execute(
        f"CREATE OR REPLACE TABLE {sql_identifier(table_name)} AS "
        f"SELECT {', '.join(projections)} FROM ST_Read({sql_string(path)}) "
        "WHERE geom IS NOT NULL"
    )
    connection.execute(
        f"""
        ALTER TABLE {sql_identifier(table_name)} ADD COLUMN min_x DOUBLE;
        ALTER TABLE {sql_identifier(table_name)} ADD COLUMN max_x DOUBLE;
        ALTER TABLE {sql_identifier(table_name)} ADD COLUMN min_y DOUBLE;
        ALTER TABLE {sql_identifier(table_name)} ADD COLUMN max_y DOUBLE;
        UPDATE {sql_identifier(table_name)}
        SET
            min_x = ST_XMin(geom),
            max_x = ST_XMax(geom),
            min_y = ST_YMin(geom),
            max_y = ST_YMax(geom);
        """
    )


def create_duckdb_polygon_matches(
    connection: Any,
    layer_table: str,
    match_table: str,
    output_fields: Sequence[str],
    batch_points: int,
    memory_bounded: bool = False,
) -> None:
    first_fields = [
        (
            f"first(layer.{sql_identifier(field)} ORDER BY layer.feature_order) "
            f"FILTER (WHERE layer.feature_order IS NOT NULL) "
            f"AS {sql_identifier(field)}"
        )
        for field in output_fields
    ]
    field_definitions = ", ".join(
        f"{sql_identifier(field)} VARCHAR" for field in output_fields
    )
    if field_definitions:
        field_definitions += ", "
    connection.execute(
        f"""
        CREATE OR REPLACE TABLE {sql_identifier(match_table)} (
            point_key VARCHAR,
            {field_definitions}
            match_count INTEGER
        )
        """
    )
    shard_counts = connection.execute(
        "SELECT shard_id, count(*) FROM points GROUP BY shard_id ORDER BY shard_id"
    ).fetchall()
    batches: list[list[int]] = []
    current_batch: list[int] = []
    current_count = 0
    for shard_id, point_count in shard_counts:
        if current_batch and current_count + point_count > batch_points:
            batches.append(current_batch)
            current_batch = []
            current_count = 0
        current_batch.append(shard_id)
        current_count += point_count
    if current_batch:
        batches.append(current_batch)

    select_expressions = ["points.point_key", *first_fields]
    select_expressions.append("count(layer.feature_order)::INTEGER AS match_count")
    if memory_bounded:
        # Wrapping ST_Intersects prevents DuckDB's spatial-join optimizer from
        # building a large in-memory index for exceptionally detailed polygons.
        join_condition = """
            points.longitude >= layer.min_x
            AND points.longitude <= layer.max_x
            AND points.latitude >= layer.min_y
            AND points.latitude <= layer.max_y
            AND CASE
                WHEN ST_Intersects(points.geom, layer.geom) THEN TRUE
                ELSE FALSE
            END
        """
    else:
        join_condition = "ST_Intersects(points.geom, layer.geom)"
    for batch_number, shard_ids in enumerate(batches, start=1):
        shard_list = ", ".join(str(shard_id) for shard_id in shard_ids)
        connection.execute(
            f"""
            INSERT INTO {sql_identifier(match_table)}
            SELECT
                {", ".join(select_expressions)}
            FROM (
                SELECT point_key, longitude, latitude, geom FROM points
                WHERE shard_id IN ({shard_list})
            ) AS points
            LEFT JOIN {sql_identifier(layer_table)} AS layer
                ON {join_condition}
            GROUP BY points.point_key
            """
        )
        print(
            f"  {layer_table}: completed spatial batch "
            f"{batch_number}/{len(batches)}"
        )


def discard_duckdb_polygon_table(connection: Any, table_name: str) -> None:
    """Release source geometries after their point matches are materialized."""
    connection.execute(f"DROP TABLE {sql_identifier(table_name)}")
    connection.execute("CHECKPOINT")


def extract_local_covariates(args: argparse.Namespace) -> None:
    """Extract local polygon indicators with DuckDB and write Parquet outputs."""
    work_dir = Path(args.work_dir).resolve()
    connection = connect_state(work_dir)
    try:
        require_current_schema(connection)
        if args.threads < 1:
            raise CovariateError("--threads must be at least 1.")
        if args.spatial_batch_points < 1:
            raise CovariateError("--spatial-batch-points must be at least 1.")
        points_csv = (
            Path(args.points_csv).resolve()
            if args.points_csv
            else stage_path(work_dir).resolve()
        )
        if not points_csv.is_file():
            raise CovariateError(f"Point CSV does not exist: {points_csv}")
        output = Path(args.output_parquet).resolve()
        points_parquet = Path(args.points_parquet).resolve()
        gee_covariates_csv = (
            Path(args.gee_covariates_csv).resolve()
            if args.gee_covariates_csv
            else None
        )
        gee_covariates_parquet = Path(args.gee_covariates_parquet).resolve()
        database = (
            Path(args.database).resolve()
            if args.database
            else (work_dir / "covariates.duckdb").resolve()
        )
        output_paths = [output, points_parquet, database]
        if gee_covariates_csv and gee_covariates_csv.is_file():
            output_paths.append(gee_covariates_parquet)
        existing_outputs = [path for path in output_paths if path.exists()]
        if existing_outputs and not args.force:
            raise CovariateError(
                f"Output(s) already exist: {[str(path) for path in existing_outputs]}. "
                "Use --force to replace them."
            )
        for path in output_paths:
            path.parent.mkdir(parents=True, exist_ok=True)
        if args.force:
            for path in output_paths:
                path.unlink(missing_ok=True)
            Path(f"{database}.wal").unlink(missing_ok=True)
            shutil.rmtree(work_dir / "duckdb_tmp", ignore_errors=True)

        state_path_arg = Path(args.states).resolve()
        ecoregion_path = Path(args.ecoregions).resolve()
        huc02_path = Path(args.huc02).resolve()
        sagebrush_path = Path(args.sagebrush).resolve()
        try:
            import duckdb
        except ImportError as exc:
            raise CovariateError(
                "The duckdb package is required for local extraction."
            ) from exc
        duck = duckdb.connect(str(database))
        try:
            duck.execute("INSTALL spatial")
            duck.execute("LOAD spatial")
            duck.execute(f"SET memory_limit={sql_string(args.memory_limit)}")
            duck.execute(f"SET threads={args.threads}")
            duck.execute("SET preserve_insertion_order=false")
            duck.execute(f"SET temp_directory={sql_string(work_dir / 'duckdb_tmp')}")

            print("Importing staged points into DuckDB...")
            duck.execute(
                f"""
                CREATE OR REPLACE TABLE points AS
                SELECT
                    point_key::VARCHAR AS point_key,
                    longitude::DOUBLE AS longitude,
                    latitude::DOUBLE AS latitude,
                    shard_id::INTEGER AS shard_id,
                    ST_Point(longitude::DOUBLE, latitude::DOUBLE) AS geom
                FROM read_csv(
                    {sql_string(points_csv)}, header = true, all_varchar = true
                )
                ORDER BY shard_id, point_key
                """
            )
            row_count = duck.execute("SELECT count(*) FROM points").fetchone()[0]
            expected_count = get_metadata(connection, "unique_point_count")
            if row_count != expected_count:
                raise CovariateError(
                    f"DuckDB imported {row_count} points; expected {expected_count}"
                )
            duck.execute(
                f"COPY points TO {sql_string(points_parquet)} "
                "(FORMAT PARQUET, COMPRESSION ZSTD)"
            )

            print("Extracting states...")
            create_duckdb_polygon_table(
                duck,
                "states",
                state_path_arg,
                {"state_name": "NAME", "state_abbr": "STUSPS"},
            )
            create_duckdb_polygon_matches(
                duck,
                "states",
                "point_states",
                ("state_name", "state_abbr"),
                args.spatial_batch_points,
            )
            discard_duckdb_polygon_table(duck, "states")

            print("Extracting Level I, Level II, and Level III ecoregions...")
            create_duckdb_polygon_table(
                duck,
                "ecoregions",
                ecoregion_path,
                {
                    "ecoregion_l1_name": "NA_L1NAME",
                    "ecoregion_l1_id": "NA_L1CODE",
                    "ecoregion_l2_name": "NA_L2NAME",
                    "ecoregion_l2_id": "NA_L2CODE",
                    "ecoregion_l3_name": "US_L3NAME",
                    "ecoregion_l3_id": "US_L3CODE",
                },
            )
            create_duckdb_polygon_matches(
                duck,
                "ecoregions",
                "point_ecoregions",
                (
                    "ecoregion_l1_name",
                    "ecoregion_l1_id",
                    "ecoregion_l2_name",
                    "ecoregion_l2_id",
                    "ecoregion_l3_name",
                    "ecoregion_l3_id",
                ),
                args.spatial_batch_points,
            )
            discard_duckdb_polygon_table(duck, "ecoregions")

            huc02_available = huc02_path.is_file()
            huc_id_field = None
            huc_name_field = None
            if huc02_available:
                print("Extracting HUC02 watersheds...")
                huc_columns = duckdb_vector_fields(duck, huc02_path)
                huc_id_field = resolve_layer_field(
                    huc_columns,
                    args.huc_id_field,
                    ("HUC2", "HUC02", "HUC_2", "HUC_02", "HUC2_ID", "HUC02_ID"),
                    "HUC02 ID",
                )
                huc_name_field = resolve_layer_field(
                    huc_columns,
                    args.huc_name_field,
                    (
                        "NAME",
                        "BASIN_NAME",
                        "HUC2_NAME",
                        "HUC02_NAME",
                        "HU_2_NAME",
                        "GNIS_NAME",
                    ),
                    "HUC02 name",
                )
                create_duckdb_polygon_table(
                    duck,
                    "huc02",
                    huc02_path,
                    {"huc02_name": huc_name_field, "huc02_id": huc_id_field},
                )
                create_duckdb_polygon_matches(
                    duck,
                    "huc02",
                    "point_huc02",
                    ("huc02_name", "huc02_id"),
                    args.spatial_batch_points,
                    memory_bounded=True,
                )
                discard_duckdb_polygon_table(duck, "huc02")
                duck.execute(
                    """
                    UPDATE point_huc02
                    SET huc02_id = lpad(huc02_id, 2, '0')
                    WHERE huc02_id IS NOT NULL
                    """
                )
            else:
                print(f"HUC02 file is not available; writing null placeholders: {huc02_path}")
                duck.execute(
                    """
                    CREATE OR REPLACE TABLE point_huc02 AS
                    SELECT
                        point_key,
                        NULL::VARCHAR AS huc02_name,
                        NULL::VARCHAR AS huc02_id,
                        0::INTEGER AS match_count
                    FROM points
                    """
                )

            print("Extracting sagebrush-biome membership...")
            create_duckdb_polygon_table(duck, "sagebrush", sagebrush_path, {})
            create_duckdb_polygon_matches(
                duck,
                "sagebrush",
                "point_sagebrush",
                (),
                args.spatial_batch_points,
                memory_bounded=True,
            )
            discard_duckdb_polygon_table(duck, "sagebrush")

            duck.execute(
                """
                CREATE OR REPLACE TABLE local_covariates AS
                SELECT
                    points.point_key,
                    point_states.state_name,
                    point_states.state_abbr,
                    point_ecoregions.ecoregion_l1_name,
                    point_ecoregions.ecoregion_l1_id,
                    point_ecoregions.ecoregion_l2_name,
                    point_ecoregions.ecoregion_l2_id,
                    point_ecoregions.ecoregion_l3_name,
                    point_ecoregions.ecoregion_l3_id,
                    point_huc02.huc02_name,
                    point_huc02.huc02_id,
                    (point_sagebrush.match_count > 0) AS in_sagebrush_biome
                FROM points
                JOIN point_states USING (point_key)
                JOIN point_ecoregions USING (point_key)
                JOIN point_huc02 USING (point_key)
                JOIN point_sagebrush USING (point_key)
                """
            )
            duck.execute(
                f"COPY local_covariates TO {sql_string(output)} "
                "(FORMAT PARQUET, COMPRESSION ZSTD)"
            )
            output_count = duck.execute(
                "SELECT count(*) FROM local_covariates"
            ).fetchone()[0]
            if output_count != expected_count:
                raise CovariateError(
                    f"Local output contains {output_count} rows; expected {expected_count}"
                )

            gee_status = "not_requested"
            if gee_covariates_csv:
                if gee_covariates_csv.is_file():
                    print("Converting Earth Engine covariates to typed Parquet...")
                    nlcd_casts = ", ".join(
                        (
                            f"TRY_CAST(NULLIF({sql_identifier(band)}, '') AS SMALLINT) "
                            f"AS {sql_identifier(band)}"
                        )
                        for band in NLCD_BANDS
                    )
                    duck.execute(
                        f"""
                        CREATE OR REPLACE TABLE gee_covariates AS
                        SELECT
                            point_key::VARCHAR AS point_key,
                            TRY_CAST(NULLIF(elevation_m, '') AS DOUBLE) AS elevation_m,
                            {nlcd_casts}
                        FROM read_csv(
                            {sql_string(gee_covariates_csv)},
                            header = true,
                            all_varchar = true
                        )
                        """
                    )
                    gee_count = duck.execute(
                        "SELECT count(*) FROM gee_covariates"
                    ).fetchone()[0]
                    if gee_count != expected_count:
                        raise CovariateError(
                            f"Earth Engine covariates contain {gee_count} rows; "
                            f"expected {expected_count}"
                        )
                    duck.execute(
                        f"COPY gee_covariates TO {sql_string(gee_covariates_parquet)} "
                        "(FORMAT PARQUET, COMPRESSION ZSTD)"
                    )
                    gee_status = "converted"
                else:
                    gee_status = "source_missing"
                    print(
                        "Earth Engine covariate CSV is not available; skipping its "
                        f"Parquet conversion and join: {gee_covariates_csv}"
                    )
            missing_counts = {
                "states": duck.execute(
                    "SELECT count(*) FROM point_states WHERE match_count = 0"
                ).fetchone()[0],
                "ecoregions": duck.execute(
                    "SELECT count(*) FROM point_ecoregions WHERE match_count = 0"
                ).fetchone()[0],
                "huc02": duck.execute(
                    "SELECT count(*) FROM point_huc02 WHERE match_count = 0"
                ).fetchone()[0],
            }
            multiple_match_counts = {
                "states": duck.execute(
                    "SELECT count(*) FROM point_states WHERE match_count > 1"
                ).fetchone()[0],
                "ecoregions": duck.execute(
                    "SELECT count(*) FROM point_ecoregions WHERE match_count > 1"
                ).fetchone()[0],
                "huc02": duck.execute(
                    "SELECT count(*) FROM point_huc02 WHERE match_count > 1"
                ).fetchone()[0],
                "sagebrush": duck.execute(
                    "SELECT count(*) FROM point_sagebrush WHERE match_count > 1"
                ).fetchone()[0],
            }
        finally:
            duck.close()

        source_metadata = {
            "database": str(database),
            "points_csv": str(points_csv),
            "points_parquet": str(points_parquet),
            "gee_covariates_csv": str(gee_covariates_csv) if gee_covariates_csv else None,
            "gee_covariates_parquet": str(gee_covariates_parquet),
            "gee_covariates_status": gee_status,
            "states": str(state_path_arg),
            "ecoregions": str(ecoregion_path),
            "huc02": str(huc02_path),
            "huc02_status": "available" if huc02_available else "placeholder_nulls",
            "sagebrush": str(sagebrush_path),
            "huc02_id_field": huc_id_field,
            "huc02_name_field": huc_name_field,
            "vector_file_provenance": {
                "states": shapefile_provenance(state_path_arg),
                "ecoregions": shapefile_provenance(ecoregion_path),
                "huc02": shapefile_provenance(huc02_path),
                "sagebrush": shapefile_provenance(sagebrush_path),
            },
        }
        set_metadata(connection, "local_covariates_at", utc_now())
        set_metadata(connection, "local_covariates_parquet", str(output))
        set_metadata(connection, "local_covariates_row_count", row_count)
        set_metadata(connection, "local_covariates_missing_counts", missing_counts)
        set_metadata(
            connection,
            "local_covariates_multiple_match_counts",
            multiple_match_counts,
        )
        set_metadata(connection, "local_covariate_sources", source_metadata)
        connection.commit()
        write_manifest(connection, work_dir)
        print(
            f"Wrote {row_count:,} local point-covariate rows to {output} and "
            f"points to {points_parquet}; GEE status={gee_status}, missing={missing_counts}, "
            f"multiple_matches={multiple_match_counts}"
        )
    finally:
        connection.close()


def duckdb_relation_columns(connection: Any, relation_sql: str) -> list[str]:
    return [
        row[0]
        for row in connection.execute(f"DESCRIBE SELECT * FROM {relation_sql}").fetchall()
    ]


def require_relation_columns(
    connection: Any,
    relation_sql: str,
    required: Sequence[str],
    label: str,
) -> None:
    columns = duckdb_relation_columns(connection, relation_sql)
    missing = set(required) - set(columns)
    if missing:
        raise CovariateError(
            f"{label} is missing required columns {sorted(missing)}. "
            f"Available columns: {sorted(columns)}"
        )


def validate_duckdb_unique_key(
    connection: Any,
    relation_sql: str,
    key: str,
    expected_count: int,
    label: str,
) -> None:
    count, distinct_count, null_count = connection.execute(
        f"""
        SELECT
            count(*),
            count(DISTINCT {sql_identifier(key)}),
            count(*) FILTER (WHERE {sql_identifier(key)} IS NULL)
        FROM {relation_sql}
        """
    ).fetchone()
    if count != expected_count or distinct_count != expected_count or null_count:
        raise CovariateError(
            f"{label} key validation failed: rows={count}, distinct_{key}="
            f"{distinct_count}, null_{key}={null_count}, expected={expected_count}"
        )


def create_ecoregion_l1_lookup(connection: Any, path: Path) -> None:
    required = ("US_L3CODE", "NA_L1CODE", "NA_L1NAME")
    available = duckdb_vector_fields(connection, path)
    missing = set(required) - set(available)
    if missing:
        raise CovariateError(
            f"Ecoregion file is missing Level I lookup fields {sorted(missing)}: {path}"
        )
    ambiguous_count = connection.execute(
        f"""
        SELECT count(*)
        FROM (
            SELECT US_L3CODE
            FROM ST_Read({sql_string(path)})
            WHERE US_L3CODE IS NOT NULL
            GROUP BY US_L3CODE
            HAVING
                count(DISTINCT NA_L1CODE) > 1
                OR count(DISTINCT NA_L1NAME) > 1
        )
        """
    ).fetchone()[0]
    if ambiguous_count:
        raise CovariateError(
            f"Ecoregion file contains {ambiguous_count} Level III ID(s) with "
            "ambiguous Level I mappings."
        )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE ecoregion_l1_lookup AS
        SELECT
            US_L3CODE::VARCHAR AS ecoregion_l3_id,
            first(NA_L1NAME ORDER BY OGC_FID)::VARCHAR AS ecoregion_l1_name,
            first(NA_L1CODE ORDER BY OGC_FID)::VARCHAR AS ecoregion_l1_id
        FROM ST_Read({sql_string(path)})
        WHERE US_L3CODE IS NOT NULL
        GROUP BY US_L3CODE
        """
    )


def merge_parquet(args: argparse.Namespace) -> None:
    """Build one validated sample-level Parquet from normalized covariate tables."""
    work_dir = Path(args.work_dir).resolve()
    connection = connect_state(work_dir)
    try:
        require_current_schema(connection)
        if args.threads < 1:
            raise CovariateError("--threads must be at least 1.")
        samples_path = Path(args.samples_parquet).resolve()
        points_path = Path(args.points_parquet).resolve()
        gee_path = Path(args.gee_covariates_parquet).resolve()
        local_path = Path(args.local_covariates_parquet).resolve()
        ecoregion_path = Path(args.ecoregions).resolve()
        output = Path(args.output_parquet).resolve()
        inputs = {
            "samples": samples_path,
            "points": points_path,
            "gee_covariates": gee_path,
            "local_covariates": local_path,
            "ecoregions": ecoregion_path,
        }
        missing_inputs = [str(path) for path in inputs.values() if not path.is_file()]
        if missing_inputs:
            raise CovariateError(f"Required merge input(s) do not exist: {missing_inputs}")
        if output.exists() and not args.force:
            raise CovariateError(f"Output already exists: {output}. Use --force to replace it.")
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        temporary.unlink(missing_ok=True)

        try:
            import duckdb
        except ImportError as exc:
            raise CovariateError(
                "The duckdb package is required for Parquet merging."
            ) from exc

        source_count = get_metadata(connection, "source_row_count")
        point_count = get_metadata(connection, "unique_point_count")
        duck = duckdb.connect()
        try:
            duck.execute("INSTALL sqlite")
            duck.execute("LOAD sqlite")
            duck.execute("INSTALL spatial")
            duck.execute("LOAD spatial")
            duck.execute(f"SET memory_limit={sql_string(args.memory_limit)}")
            duck.execute(f"SET threads={args.threads}")
            duck.execute("SET preserve_insertion_order=true")
            duck.execute(f"SET temp_directory={sql_string(work_dir / 'duckdb_merge_tmp')}")

            state_database = state_path(work_dir).resolve()
            relations = {
                "samples": f"read_parquet({sql_string(samples_path)})",
                "points": f"read_parquet({sql_string(points_path)})",
                "gee": f"read_parquet({sql_string(gee_path)})",
                "local": f"read_parquet({sql_string(local_path)})",
                "mapping": (
                    f"sqlite_scan({sql_string(state_database)}, 'source_rows')"
                ),
            }
            require_relation_columns(
                duck,
                relations["samples"],
                (DEFAULT_ID_COLUMN, "L7_image_id", DEFAULT_GEOMETRY_COLUMN),
                "Sample Parquet",
            )
            require_relation_columns(
                duck,
                relations["points"],
                ("point_key", "longitude", "latitude", "shard_id"),
                "Point Parquet",
            )
            require_relation_columns(
                duck,
                relations["gee"],
                ("point_key", ELEVATION_OUTPUT, *NLCD_BANDS),
                "Earth Engine covariate Parquet",
            )
            required_local = tuple(
                column
                for column in LOCAL_COVARIATE_COLUMNS
                if column not in ("ecoregion_l1_name", "ecoregion_l1_id")
            )
            require_relation_columns(
                duck,
                relations["local"],
                ("point_key", *required_local),
                "Local covariate Parquet",
            )
            require_relation_columns(
                duck,
                relations["mapping"],
                ("source_row", DEFAULT_ID_COLUMN, "point_key", "sample_year"),
                "Workflow sample mapping",
            )
            sample_columns = duckdb_relation_columns(duck, relations["samples"])
            added_columns = {
                "point_key",
                "longitude",
                "latitude",
                "shard_id",
                "image_year",
                "image_month",
                "split",
                ELEVATION_OUTPUT,
                NLCD_OUTPUT,
                *LOCAL_COVARIATE_COLUMNS,
            }
            conflicts = sorted(set(sample_columns) & added_columns)
            if conflicts:
                raise CovariateError(
                    f"Sample Parquet already contains merge output columns: {conflicts}"
                )

            validate_duckdb_unique_key(
                duck, relations["samples"], DEFAULT_ID_COLUMN, source_count, "Sample Parquet"
            )
            validate_duckdb_unique_key(
                duck, relations["mapping"], DEFAULT_ID_COLUMN, source_count, "Workflow mapping"
            )
            for label, relation in (
                ("Point Parquet", relations["points"]),
                ("Earth Engine covariate Parquet", relations["gee"]),
                ("Local covariate Parquet", relations["local"]),
            ):
                validate_duckdb_unique_key(duck, relation, "point_key", point_count, label)

            join_validation = duck.execute(
                f"""
                SELECT
                    count(*) FILTER (WHERE mapping.leohs_id IS NULL),
                    count(*) FILTER (WHERE points.point_key IS NULL),
                    count(*) FILTER (WHERE gee.point_key IS NULL),
                    count(*) FILTER (WHERE local.point_key IS NULL)
                FROM {relations["samples"]} AS samples
                LEFT JOIN {relations["mapping"]} AS mapping USING (leohs_id)
                LEFT JOIN {relations["points"]} AS points USING (point_key)
                LEFT JOIN {relations["gee"]} AS gee USING (point_key)
                LEFT JOIN {relations["local"]} AS local USING (point_key)
                """
            ).fetchone()
            if any(join_validation):
                raise CovariateError(
                    "Normalized Parquet join validation failed: "
                    f"missing_mapping={join_validation[0]}, "
                    f"missing_points={join_validation[1]}, missing_gee={join_validation[2]}, "
                    f"missing_local={join_validation[3]}"
                )

            invalid_dates, mismatched_years = duck.execute(
                f"""
                SELECT
                    count(*) FILTER (
                        WHERE NOT regexp_full_match(right(samples.L7_image_id, 8), '[0-9]{{8}}')
                        OR try_strptime(right(samples.L7_image_id, 8), '%Y%m%d') IS NULL
                    ),
                    count(*) FILTER (
                        WHERE year(try_strptime(right(samples.L7_image_id, 8), '%Y%m%d'))
                            <> mapping.sample_year
                    )
                FROM {relations["samples"]} AS samples
                JOIN {relations["mapping"]} AS mapping USING (leohs_id)
                """
            ).fetchone()
            if invalid_dates or mismatched_years:
                raise CovariateError(
                    f"L7 image-date validation failed: invalid_dates={invalid_dates}, "
                    f"years_differ_from_prepared_state={mismatched_years}"
                )

            create_ecoregion_l1_lookup(duck, ecoregion_path)
            missing_l1_ids = duck.execute(
                f"""
                SELECT count(DISTINCT local.ecoregion_l3_id)
                FROM {relations["local"]} AS local
                LEFT JOIN ecoregion_l1_lookup AS lookup USING (ecoregion_l3_id)
                WHERE local.ecoregion_l3_id IS NOT NULL
                    AND lookup.ecoregion_l3_id IS NULL
                """
            ).fetchone()[0]
            if missing_l1_ids:
                raise CovariateError(
                    f"{missing_l1_ids} local Level III ecoregion ID(s) have no "
                    "Level I lookup."
                )

            nlcd_case = nlcd_case_expression("sample_rows", "gee")
            split_expression = (
                f"('0x' || substr(sha256({sql_string(str(args.split_seed))} || '|' || "
                "sample_rows.point_key), 1, 13))::UBIGINT / 4503599627370496.0"
            )
            final_query = f"""
                WITH sample_rows AS (
                    SELECT
                        mapping.source_row,
                        mapping.point_key,
                        mapping.sample_year,
                        try_strptime(right(samples.L7_image_id, 8), '%Y%m%d')
                            AS acquisition_date,
                        samples.*
                    FROM {relations["samples"]} AS samples
                    JOIN {relations["mapping"]} AS mapping USING (leohs_id)
                )
                SELECT
                    sample_rows.* EXCLUDE (
                        source_row, point_key, sample_year, acquisition_date
                    ),
                    sample_rows.point_key,
                    points.longitude,
                    points.latitude,
                    points.shard_id,
                    year(sample_rows.acquisition_date)::INTEGER AS image_year,
                    month(sample_rows.acquisition_date)::INTEGER AS image_month,
                    {split_expression}::DOUBLE AS split,
                    gee.elevation_m,
                    {nlcd_case}::SMALLINT AS {NLCD_OUTPUT},
                    local.state_name,
                    local.state_abbr,
                    lookup.ecoregion_l1_name,
                    lookup.ecoregion_l1_id,
                    local.ecoregion_l2_name,
                    local.ecoregion_l2_id,
                    local.ecoregion_l3_name,
                    local.ecoregion_l3_id,
                    local.huc02_name,
                    local.huc02_id,
                    local.in_sagebrush_biome
                FROM sample_rows
                JOIN {relations["points"]} AS points USING (point_key)
                JOIN {relations["gee"]} AS gee USING (point_key)
                JOIN {relations["local"]} AS local USING (point_key)
                LEFT JOIN ecoregion_l1_lookup AS lookup USING (ecoregion_l3_id)
                ORDER BY sample_rows.source_row
            """
            print("Writing sample-level covariate Parquet...")
            duck.execute(
                f"COPY ({final_query}) TO {sql_string(temporary)} "
                "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)"
            )

            output_relation = f"read_parquet({sql_string(temporary)})"
            validate_duckdb_unique_key(
                duck, output_relation, DEFAULT_ID_COLUMN, source_count, "Merged Parquet"
            )
            output_columns = duckdb_relation_columns(duck, output_relation)
            forbidden = {"geom", *NLCD_BANDS}
            unexpected = sorted(set(output_columns) & forbidden)
            if unexpected:
                raise CovariateError(
                    f"Merged Parquet contains excluded columns: {unexpected}"
                )
            expected_output_columns = {
                DEFAULT_GEOMETRY_COLUMN,
                "point_key",
                "image_year",
                "image_month",
                "split",
                ELEVATION_OUTPUT,
                NLCD_OUTPUT,
                *LOCAL_COVARIATE_COLUMNS,
            }
            missing_output = sorted(expected_output_columns - set(output_columns))
            if missing_output:
                raise CovariateError(
                    f"Merged Parquet is missing output columns: {missing_output}"
                )
            (
                distinct_points,
                split_min,
                split_max,
                bad_splits,
                split_conflicts,
                year_mismatches,
            ) = (
                duck.execute(
                    f"""
                    SELECT
                        count(DISTINCT output.point_key),
                        min(output.split),
                        max(output.split),
                        count(*) FILTER (
                            WHERE output.split < 0 OR output.split >= 1
                        ),
                        (
                            SELECT count(*)
                            FROM (
                                SELECT point_key
                                FROM {output_relation}
                                GROUP BY point_key
                                HAVING count(DISTINCT split) > 1
                            )
                        ),
                        count(*) FILTER (
                            WHERE output.image_year <> mapping.sample_year
                        )
                    FROM {output_relation} AS output
                    JOIN {relations["mapping"]} AS mapping USING (leohs_id)
                    """
                ).fetchone()
            )
            if (
                distinct_points != point_count
                or bad_splits
                or split_conflicts
                or year_mismatches
                or split_min is None
                or split_max is None
            ):
                raise CovariateError(
                    "Merged Parquet acceptance validation failed: "
                    f"distinct_points={distinct_points}, expected_points={point_count}, "
                    f"bad_splits={bad_splits}, split_conflicts={split_conflicts}, "
                    f"year_mismatches={year_mismatches}"
                )
            missing_counts = duck.execute(
                f"""
                SELECT
                    count(*) FILTER (WHERE elevation_m IS NULL),
                    count(*) FILTER (WHERE {NLCD_OUTPUT} IS NULL),
                    count(*) FILTER (WHERE state_name IS NULL),
                    count(*) FILTER (WHERE ecoregion_l1_id IS NULL),
                    count(*) FILTER (WHERE ecoregion_l2_id IS NULL),
                    count(*) FILTER (WHERE ecoregion_l3_id IS NULL),
                    count(*) FILTER (WHERE huc02_id IS NULL)
                FROM {output_relation}
                """
            ).fetchone()
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        finally:
            duck.close()

        os.replace(temporary, output)
        metadata = {
            "output": str(output),
            "row_count": source_count,
            "distinct_point_count": point_count,
            "split_seed": args.split_seed,
            "split_unit": "point_key",
            "split_method": "first 52 bits of SHA-256(seed|point_key) divided by 2^52",
            "split_min": split_min,
            "split_max": split_max,
            "missing_counts": dict(
                zip(
                    (
                        ELEVATION_OUTPUT,
                        NLCD_OUTPUT,
                        "state",
                        "ecoregion_l1",
                        "ecoregion_l2",
                        "ecoregion_l3",
                        "huc02",
                    ),
                    missing_counts,
                )
            ),
            "inputs": {
                name: {
                    "path": str(path),
                    "size_bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
                for name, path in inputs.items()
                if path.suffix.lower() != ".shp"
            },
            "ecoregion_source": shapefile_provenance(ecoregion_path),
        }
        set_metadata(connection, "sample_covariate_parquet_at", utc_now())
        set_metadata(connection, "sample_covariate_parquet", metadata)
        connection.commit()
        write_manifest(connection, work_dir)
        print(
            f"Wrote {source_count:,} sample rows across {point_count:,} unique points "
            f"to {output}; missing={metadata['missing_counts']}"
        )
    finally:
        shutil.rmtree(work_dir / "duckdb_merge_tmp", ignore_errors=True)
        connection.close()


def completed_export_tasks(
    connection: sqlite3.Connection, allow_incomplete: bool
) -> list[sqlite3.Row]:
    latest = latest_tasks(connection)
    incomplete = [
        row["shard_id"]
        for row in connection.execute("SELECT shard_id FROM shards ORDER BY shard_id")
        if row["shard_id"] not in latest
        or latest[row["shard_id"]]["state"] != "COMPLETED"
    ]
    if incomplete and not allow_incomplete:
        raise CovariateError(
            f"{len(incomplete)} shard(s) are incomplete. Run status/submit or "
            "use --allow-incomplete."
        )
    return sorted(
        (row for row in latest.values() if row["state"] == "COMPLETED"),
        key=lambda row: row["shard_id"],
    )


def combine_exports(args: argparse.Namespace) -> None:
    """Stream the latest completed shard exports into one unique-point CSV."""
    work_dir = Path(args.work_dir).resolve()
    connection = connect_state(work_dir)
    try:
        configure_cloud(
            connection, args.project, args.bucket, args.gcs_prefix, args.asset_id
        )
        ee = initialize_ee(args.project)
        refresh_export_tasks(connection, ee)
        completed = completed_export_tasks(connection, args.allow_incomplete)
        if not completed:
            raise CovariateError("No completed shard exports are available to combine.")

        output = Path(args.output_csv).resolve()
        if output.exists() and not args.force:
            raise CovariateError(f"Output already exists: {output}. Use --force to replace it.")
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        temporary.unlink(missing_ok=True)

        client = storage_client(args.project)
        bucket_name = args.bucket.removeprefix("gs://").strip("/")
        bucket = client.bucket(bucket_name)
        output_columns = ["point_key", ELEVATION_OUTPUT, *NLCD_BANDS]
        combined_rows = 0
        combined_blobs = 0
        missing_point_keys: list[str] = []
        try:
            with temporary.open("w", newline="", encoding="utf-8") as destination:
                writer = csv.DictWriter(
                    destination, fieldnames=output_columns, lineterminator="\n"
                )
                writer.writeheader()
                for task in completed:
                    expected_keys = {
                        row["point_key"]
                        for row in connection.execute(
                            "SELECT point_key FROM points WHERE shard_id = ?",
                            (task["shard_id"],),
                        )
                    }
                    seen_keys: set[str] = set()
                    blobs = sorted(
                        (
                            blob
                            for blob in client.list_blobs(
                                bucket, prefix=task["output_prefix"]
                            )
                            if blob.name.endswith(".csv")
                        ),
                        key=lambda item: item.name,
                    )
                    if not blobs:
                        raise CovariateError(
                            f"No CSV output found for completed shard {task['shard_id']} "
                            f"at gs://{bucket_name}/{task['output_prefix']}"
                        )
                    shard_rows = 0
                    for blob in blobs:
                        for row in iter_blob_csv_rows(blob):
                            key = row["point_key"]
                            if key not in expected_keys:
                                raise CovariateError(
                                    f"Shard {task['shard_id']} exported unknown "
                                    f"point_key {key!r}"
                                )
                            if key in seen_keys:
                                raise CovariateError(
                                    f"Shard {task['shard_id']} exported duplicate "
                                    f"point_key {key!r}"
                                )
                            seen_keys.add(key)
                            writer.writerow({name: row.get(name, "") for name in output_columns})
                            shard_rows += 1
                        combined_blobs += 1
                    missing_keys = sorted(expected_keys - seen_keys)
                    for key in missing_keys:
                        writer.writerow({"point_key": key})
                    missing_point_keys.extend(missing_keys)
                    expected_count = len(expected_keys)
                    if shard_rows + len(missing_keys) != expected_count:
                        raise CovariateError(
                            f"Shard {task['shard_id']} validation is inconsistent: "
                            f"exported={shard_rows}, missing={len(missing_keys)}, "
                            f"expected={expected_count}"
                        )
                    combined_rows += shard_rows
                    print(
                        f"Combined shard {task['shard_id']} "
                        f"({shard_rows:,} exported rows, {len(missing_keys):,} "
                        f"blank missing-point rows; {combined_rows:,} exported total)"
                    )
            os.replace(temporary, output)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

        set_metadata(connection, "combined_exports_at", utc_now())
        set_metadata(connection, "combined_exports_csv", str(output))
        set_metadata(
            connection,
            "combined_exports_row_count",
            combined_rows + len(missing_point_keys),
        )
        set_metadata(connection, "combined_exports_exported_row_count", combined_rows)
        set_metadata(connection, "combined_exports_blob_count", combined_blobs)
        set_metadata(connection, "combined_exports_shard_count", len(completed))
        set_metadata(
            connection,
            "combined_exports_missing_point_count",
            len(missing_point_keys),
        )
        set_metadata(
            connection,
            "combined_exports_missing_point_keys",
            missing_point_keys,
        )
        connection.commit()
        write_manifest(connection, work_dir)
        print(
            f"Combined {combined_rows + len(missing_point_keys):,} unique-point rows "
            f"({combined_rows:,} exported, {len(missing_point_keys):,} preserved "
            f"with blank covariates) from "
            f"{combined_blobs:,} GCS object(s) and {len(completed):,} shard(s) "
            f"into {output}"
        )
    finally:
        connection.close()


def collect(args: argparse.Namespace) -> None:
    work_dir = Path(args.work_dir).resolve()
    connection = connect_state(work_dir)
    try:
        configure_cloud(
            connection, args.project, args.bucket, args.gcs_prefix, args.asset_id
        )
        ee = initialize_ee(args.project)
        refresh_export_tasks(connection, ee)
        completed = completed_export_tasks(connection, args.allow_incomplete)

        connection.execute("DROP TABLE IF EXISTS results_new")
        nlcd_column_definitions = ",\n".join(
            f"                {band} TEXT" for band in NLCD_BANDS
        )
        connection.execute(
            f"""
            CREATE TABLE results_new (
                point_key TEXT PRIMARY KEY,
                elevation_m TEXT,
{nlcd_column_definitions},
                shard_id INTEGER NOT NULL
            )
            """
        )
        client = storage_client(args.project)
        bucket_name = args.bucket.removeprefix("gs://").strip("/")
        bucket = client.bucket(bucket_name)
        collected_rows = 0
        missing_export_rows = 0
        elevation_missing = 0
        nlcd_missing_by_year: Counter[int] = Counter()
        result_columns = ["point_key", ELEVATION_OUTPUT, *NLCD_BANDS, "shard_id"]
        result_placeholders = ", ".join("?" for _ in result_columns)
        result_column_sql = ", ".join(result_columns)
        for task in completed:
            expected_keys = {
                row["point_key"]
                for row in connection.execute(
                    "SELECT point_key FROM points WHERE shard_id = ?",
                    (task["shard_id"],),
                )
            }
            seen_keys: set[str] = set()
            blobs = [
                blob
                for blob in client.list_blobs(bucket, prefix=task["output_prefix"])
                if blob.name.endswith(".csv")
            ]
            if not blobs:
                raise CovariateError(
                    f"No CSV output found for completed shard {task['shard_id']} "
                    f"at gs://{bucket_name}/{task['output_prefix']}"
                )
            shard_rows = 0
            for blob in sorted(blobs, key=lambda item: item.name):
                for row in iter_blob_csv_rows(blob):
                    key = row.get("point_key", "")
                    if key not in expected_keys:
                        raise CovariateError(
                            f"Shard {task['shard_id']} exported unknown "
                            f"point_key {key!r} in {blob.name}"
                        )
                    if key in seen_keys:
                        raise CovariateError(
                            f"Duplicate exported point_key {key!r}"
                        )
                    seen_keys.add(key)
                    elevation = row.get(ELEVATION_OUTPUT, "")
                    nlcd_values = [row.get(band, "") for band in NLCD_BANDS]
                    try:
                        connection.execute(
                            f"INSERT INTO results_new({result_column_sql}) "
                            f"VALUES ({result_placeholders})",
                            (
                                key,
                                elevation or None,
                                *(value or None for value in nlcd_values),
                                task["shard_id"],
                            ),
                        )
                    except sqlite3.IntegrityError as exc:
                        raise CovariateError(
                            f"Duplicate exported point_key {key!r}"
                        ) from exc
                    collected_rows += 1
                    shard_rows += 1
                    elevation_missing += not bool(elevation)
                    for year, value in zip(NLCD_YEARS, nlcd_values):
                        nlcd_missing_by_year[year] += not bool(value)
            missing_keys = sorted(expected_keys - seen_keys)
            for key in missing_keys:
                connection.execute(
                    f"INSERT INTO results_new({result_column_sql}) "
                    f"VALUES ({result_placeholders})",
                    (
                        key,
                        None,
                        *(None for _ in NLCD_BANDS),
                        task["shard_id"],
                    ),
                )
            missing_export_rows += len(missing_keys)
            collected_rows += len(missing_keys)
            elevation_missing += len(missing_keys)
            for year in NLCD_YEARS:
                nlcd_missing_by_year[year] += len(missing_keys)

        connection.execute("DELETE FROM results")
        connection.execute(
            f"INSERT INTO results({result_column_sql}) "
            f"SELECT {result_column_sql} FROM results_new"
        )
        connection.execute("DROP TABLE results_new")
        set_metadata(connection, "collected_at", utc_now())
        set_metadata(connection, "collected_point_count", collected_rows)
        set_metadata(connection, "elevation_missing_count", elevation_missing)
        set_metadata(connection, "missing_export_point_count", missing_export_rows)
        set_metadata(
            connection,
            "annual_nlcd_missing_point_counts",
            dict(sorted(nlcd_missing_by_year.items())),
        )
        connection.commit()

        output = Path(args.output_csv).resolve() if args.output_csv else result_path(work_dir)
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        nlcd_case = nlcd_case_expression()
        with temporary.open("w", newline="", encoding="utf-8") as destination:
            writer = csv.writer(destination, lineterminator="\n")
            writer.writerow(
                [DEFAULT_ID_COLUMN, SAMPLE_YEAR_OUTPUT, ELEVATION_OUTPUT, NLCD_OUTPUT]
            )
            for row in connection.execute(
                f"""
                SELECT sr.leohs_id, sr.sample_year, r.elevation_m,
                       {nlcd_case} AS {NLCD_OUTPUT}
                FROM source_rows sr
                LEFT JOIN results r ON r.point_key = sr.point_key
                ORDER BY sr.leohs_id
                """
            ):
                writer.writerow(
                    [
                        row["leohs_id"],
                        row["sample_year"],
                        row["elevation_m"] or "",
                        row[NLCD_OUTPUT] or "",
                    ]
                )
        os.replace(temporary, output)
        set_metadata(connection, "covariate_csv", str(output))
        set_metadata(
            connection,
            "covariate_row_count",
            get_metadata(connection, "source_row_count"),
        )
        sample_missing = connection.execute(
            f"""
            SELECT
                SUM(r.elevation_m IS NULL) AS elevation_missing,
                SUM(({nlcd_case}) IS NULL) AS nlcd_missing
            FROM source_rows sr
            LEFT JOIN results r ON r.point_key = sr.point_key
            """
        ).fetchone()
        set_metadata(
            connection,
            "covariate_elevation_missing_row_count",
            sample_missing["elevation_missing"],
        )
        set_metadata(
            connection,
            "covariate_nlcd_missing_row_count",
            sample_missing["nlcd_missing"],
        )
        connection.commit()
        write_manifest(connection, work_dir)
        sample_rows = get_metadata(connection, "source_row_count")
        print(
            f"Collected {collected_rows:,} unique points and wrote "
            f"{sample_rows:,} {DEFAULT_ID_COLUMN}-keyed rows to {output}; "
            f"preserved missing export points={missing_export_rows:,}, "
            f"sample rows missing elevation={sample_missing['elevation_missing']:,}, "
            f"missing NLCD={sample_missing['nlcd_missing']:,}"
        )
    finally:
        connection.close()


def merge(args: argparse.Namespace) -> None:
    work_dir = Path(args.work_dir).resolve()
    connection = connect_state(work_dir)
    try:
        require_current_schema(connection)
        input_csv = (
            Path(args.input_csv).resolve()
            if args.input_csv
            else Path(get_metadata(connection, "input_csv"))
        )
        if sha256_file(input_csv) != get_metadata(connection, "input_sha256"):
            raise CovariateError(
                f"Input checksum differs from the prepared source: {input_csv}"
            )
        result_count = connection.execute(
            "SELECT COUNT(*) AS count FROM results"
        ).fetchone()["count"]
        if not result_count:
            raise CovariateError("No collected results exist. Run collect first.")
        output = Path(args.output_csv).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        nlcd_case = nlcd_case_expression()
        mapping = connection.execute(
            f"""
            SELECT sr.source_row, sr.leohs_id, sr.point_key,
                   sr.sample_year,
                   r.point_key AS result_point_key,
                   r.elevation_m, {nlcd_case} AS {NLCD_OUTPUT}
            FROM source_rows sr
            LEFT JOIN results r ON r.point_key = sr.point_key
            ORDER BY sr.source_row
            """
        )
        merged_rows = 0
        missing_results = 0
        with input_csv.open("r", newline="", encoding="utf-8") as source, temporary.open(
            "w", newline="", encoding="utf-8"
        ) as destination:
            reader = csv.DictReader(source)
            fieldnames = list(reader.fieldnames or [])
            for name in (SAMPLE_YEAR_OUTPUT, ELEVATION_OUTPUT, NLCD_OUTPUT):
                if name in fieldnames:
                    raise CovariateError(
                        f"Input already contains output column {name!r}: {input_csv}"
                    )
            writer = csv.DictWriter(
                destination,
                fieldnames=fieldnames
                + [SAMPLE_YEAR_OUTPUT, ELEVATION_OUTPUT, NLCD_OUTPUT],
                lineterminator="\n",
            )
            writer.writeheader()
            for source_row, (row, values) in enumerate(zip(reader, mapping)):
                if values["source_row"] != source_row:
                    raise CovariateError("Source-row mapping is inconsistent.")
                if row.get(DEFAULT_ID_COLUMN) != values["leohs_id"]:
                    raise CovariateError(
                        f"{DEFAULT_ID_COLUMN} differs from prepared state at "
                        f"source row {source_row}"
                    )
                row[SAMPLE_YEAR_OUTPUT] = values["sample_year"]
                row[ELEVATION_OUTPUT] = values["elevation_m"] or ""
                row[NLCD_OUTPUT] = values[NLCD_OUTPUT] or ""
                missing_results += values["result_point_key"] is None
                writer.writerow(row)
                merged_rows += 1
            if next(reader, None) is not None or mapping.fetchone() is not None:
                raise CovariateError("Source-row mapping count differs from the input CSV.")
        os.replace(temporary, output)
        set_metadata(connection, "merged_at", utc_now())
        set_metadata(connection, "merged_csv", str(output))
        set_metadata(connection, "merged_row_count", merged_rows)
        set_metadata(connection, "merged_missing_result_count", missing_results)
        connection.commit()
        write_manifest(connection, work_dir)
        print(
            f"Merged {merged_rows:,} source rows to {output}; "
            f"rows without collected covariates={missing_results:,}"
        )
    finally:
        connection.close()


def write_manifest(connection: sqlite3.Connection, work_dir: Path) -> None:
    metadata = {
        row["key"]: json.loads(row["value"])
        for row in connection.execute("SELECT key, value FROM metadata ORDER BY key")
    }
    shards = [
        dict(row)
        for row in connection.execute(
            """
            SELECT shard_id, lon_min, lat_min, lon_max, lat_max, point_count
            FROM shards ORDER BY shard_id
            """
        )
    ]
    tasks = [
        dict(row)
        for row in connection.execute(
            """
            SELECT shard_id, attempt, task_id, state, output_prefix,
                   error_message, submitted_at, updated_at
            FROM tasks ORDER BY shard_id, attempt
            """
        )
    ]
    manifest = {
        "schema_version": WORKFLOW_SCHEMA_VERSION,
        "updated_at": utc_now(),
        "metadata": metadata,
        "covariates": {
            ELEVATION_OUTPUT: {
                "asset": ELEVATION_ASSET,
                "sampling": "native raster cell containing the point",
            },
            NLCD_OUTPUT: {
                "asset": NLCD_ASSET,
                "available_years": list(NLCD_YEARS),
                "year_matching": (
                    "L7_image_id and L8_image_id acquisition years must match; "
                    "the annual NLCD class for that sample year is selected locally"
                ),
                "sampling": "native raster cell containing the point",
            },
        },
        "shards": shards,
        "tasks": tasks,
    }
    destination = manifest_path(work_dir)
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, destination)


def add_work_dir(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--work-dir",
        default=str(DEFAULT_WORK_DIR),
        help=f"Workflow state directory (default: {DEFAULT_WORK_DIR})",
    )


def add_cloud_arguments(parser: argparse.ArgumentParser) -> None:
    add_work_dir(parser)
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--bucket", required=True, help="GCS bucket name")
    parser.add_argument("--gcs-prefix", required=True, help="GCS object prefix")
    parser.add_argument("--asset-id", required=True, help="Earth Engine table asset ID")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare", help="Prepare local state and points")
    prepare_parser.add_argument(
        "input_csv",
        nargs="?",
        default=str(DEFAULT_INPUT_CSV),
        help=f"ID-bearing source CSV (default: {DEFAULT_INPUT_CSV})",
    )
    add_work_dir(prepare_parser)
    prepare_parser.add_argument("--geometry-column", default=DEFAULT_GEOMETRY_COLUMN)
    prepare_parser.add_argument("--force", action="store_true")
    prepare_parser.set_defaults(func=prepare)

    ingest_parser = subparsers.add_parser("ingest", help="Upload and ingest the point table")
    add_cloud_arguments(ingest_parser)
    ingest_parser.add_argument("--overwrite", action="store_true")
    ingest_parser.set_defaults(func=ingest)

    submit_parser = subparsers.add_parser("submit", help="Submit shard export tasks")
    add_cloud_arguments(submit_parser)
    submit_parser.add_argument("--max-active", type=int, default=50)
    submit_parser.add_argument("--tile-scale", type=int, default=4)
    submit_parser.add_argument("--retry-failed", action="store_true")
    submit_parser.add_argument(
        "--resubmit-completed",
        action="store_true",
        help="Create a new attempt for explicitly selected completed shards",
    )
    submit_parser.add_argument("--shard-id", type=int, action="append")
    submit_parser.set_defaults(func=submit)

    status_parser = subparsers.add_parser("status", help="Refresh and display task status")
    add_work_dir(status_parser)
    status_parser.add_argument("--project", default=DEFAULT_PROJECT)
    status_parser.set_defaults(func=status)

    combine_parser = subparsers.add_parser(
        "combine-exports",
        help="Stream completed raw shard exports into one local CSV",
    )
    add_cloud_arguments(combine_parser)
    combine_parser.add_argument(
        "--output-csv",
        default=str(DEFAULT_COMBINED_EXPORT_CSV),
        help=f"Combined raw export CSV (default: {DEFAULT_COMBINED_EXPORT_CSV})",
    )
    combine_parser.add_argument("--allow-incomplete", action="store_true")
    combine_parser.add_argument("--force", action="store_true")
    combine_parser.set_defaults(func=combine_exports)

    local_parser = subparsers.add_parser(
        "extract-local",
        help="Extract local polygon covariates for staged unique points",
    )
    add_work_dir(local_parser)
    local_parser.add_argument("--points-csv")
    local_parser.add_argument(
        "--output-parquet",
        default=str(DEFAULT_LOCAL_COVARIATE_PARQUET),
        help=(
            "Local covariate Parquet output "
            f"(default: {DEFAULT_LOCAL_COVARIATE_PARQUET})"
        ),
    )
    local_parser.add_argument(
        "--points-parquet",
        default=str(DEFAULT_POINTS_PARQUET),
        help=f"Point Parquet output (default: {DEFAULT_POINTS_PARQUET})",
    )
    local_parser.add_argument(
        "--gee-covariates-csv",
        default=str(DEFAULT_COMBINED_EXPORT_CSV),
        help="Raw combined Earth Engine covariate CSV to convert and join",
    )
    local_parser.add_argument(
        "--gee-covariates-parquet",
        default=str(DEFAULT_GEE_COVARIATE_PARQUET),
    )
    local_parser.add_argument("--database")
    local_parser.add_argument("--states", default=str(DEFAULT_STATE_SHP))
    local_parser.add_argument("--ecoregions", default=str(DEFAULT_ECOREGION_SHP))
    local_parser.add_argument("--huc02", default=str(DEFAULT_HUC02_SHP))
    local_parser.add_argument("--sagebrush", default=str(DEFAULT_SAGEBRUSH_SHP))
    local_parser.add_argument("--huc-id-field")
    local_parser.add_argument("--huc-name-field")
    local_parser.add_argument("--memory-limit", default="8GB")
    local_parser.add_argument("--threads", type=int, default=1)
    local_parser.add_argument("--spatial-batch-points", type=int, default=50_000)
    local_parser.add_argument("--force", action="store_true")
    local_parser.set_defaults(func=extract_local_covariates)

    collect_parser = subparsers.add_parser("collect", help="Validate and combine GCS exports")
    add_cloud_arguments(collect_parser)
    collect_parser.add_argument("--output-csv")
    collect_parser.add_argument("--allow-incomplete", action="store_true")
    collect_parser.set_defaults(func=collect)

    merge_parser = subparsers.add_parser("merge", help="Append covariates to the source CSV")
    add_work_dir(merge_parser)
    merge_parser.add_argument("--input-csv")
    merge_parser.add_argument("--output-csv", required=True)
    merge_parser.set_defaults(func=merge)

    parquet_merge_parser = subparsers.add_parser(
        "merge-parquet",
        help="Join sample rows with normalized point covariate Parquets",
    )
    add_work_dir(parquet_merge_parser)
    parquet_merge_parser.add_argument(
        "--samples-parquet", default=str(DEFAULT_SAMPLE_PARQUET)
    )
    parquet_merge_parser.add_argument(
        "--points-parquet", default=str(DEFAULT_POINTS_PARQUET)
    )
    parquet_merge_parser.add_argument(
        "--gee-covariates-parquet", default=str(DEFAULT_GEE_COVARIATE_PARQUET)
    )
    parquet_merge_parser.add_argument(
        "--local-covariates-parquet", default=str(DEFAULT_LOCAL_COVARIATE_PARQUET)
    )
    parquet_merge_parser.add_argument("--ecoregions", default=str(DEFAULT_ECOREGION_SHP))
    parquet_merge_parser.add_argument(
        "--output-parquet", default=str(DEFAULT_SAMPLE_COVARIATE_PARQUET)
    )
    parquet_merge_parser.add_argument("--split-seed", default="42")
    parquet_merge_parser.add_argument("--memory-limit", default="8GB")
    parquet_merge_parser.add_argument("--threads", type=int, default=4)
    parquet_merge_parser.add_argument("--force", action="store_true")
    parquet_merge_parser.set_defaults(func=merge_parquet)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except CovariateError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
