from __future__ import annotations

from functools import lru_cache
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb

from .indices import SQL_INDEX_EXPRESSIONS
from .schemas import SampleQuery
from .settings import get_settings

PARTITION_COLUMNS = {
    "ecoregion_l1": "ecoregion_l1_id",
    "ecoregion_l2": "ecoregion_l2_id",
    "ecoregion_l3": "ecoregion_l3_id",
    "huc02": "huc02_id",
    "nlcd": "CAST(nlcd_landcover AS VARCHAR)",
}


def json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    return value


def offset_expression(index: str) -> str:
    return f"({SQL_INDEX_EXPRESSIONS[index]('L8')} - {SQL_INDEX_EXPRESSIONS[index]('L7')})"


def derived_cte(source: str) -> str:
    escaped = source.replace("'", "''")
    index_columns = ",\n".join(
        f"{SQL_INDEX_EXPRESSIONS[index]('L7')} AS l7_{index.lower()}, "
        f"{SQL_INDEX_EXPRESSIONS[index]('L8')} AS l8_{index.lower()}, "
        f"{offset_expression(index)} AS {index.lower()}_offset"
        for index in ("NDVI", "EVI", "MSAVI")
    )
    band_offsets = ",\n".join(
        f"(L8_{band} - L7_{band}) AS {band.lower()}_offset"
        for band in ("B", "G", "R", "NIR", "SWIR1", "SWIR2")
    )
    return f"""
        WITH samples AS (
            SELECT *,
                {index_columns},
                {band_offsets},
                regexp_extract(L7_image_id, '(\\d{{8}})$', 1) AS l7_date,
                regexp_extract(L8_image_id, '(\\d{{8}})$', 1) AS l8_date
            FROM read_parquet('{escaped}')
        )
    """


class SampleStore:
    def __init__(self, source: str):
        self.source = source
        if not source.startswith(("http://", "https://", "gs://")) and not Path(source).is_file():
            raise FileNotFoundError(f"Sample parquet not found: {source}")

    def _connection(self) -> duckdb.DuckDBPyConnection:
        connection = duckdb.connect()
        connection.execute("SET threads=4")
        return connection

    def config(self) -> dict[str, Any]:
        connection = self._connection()
        try:
            cte = derived_cte(self.source)
            summary = connection.execute(
                cte
                + """
                SELECT count(*) AS rows, min(image_year), max(image_year),
                       min(image_month), max(image_month),
                       approx_quantile(ndvi_offset, [0.01, 0.99]),
                       approx_quantile(evi_offset, [0.01, 0.99]),
                       approx_quantile(msavi_offset, [0.01, 0.99])
                FROM samples
                """
            ).fetchone()
            categories: dict[str, list[str]] = {}
            for partition, column in PARTITION_COLUMNS.items():
                rows = connection.execute(
                    f"SELECT DISTINCT {column} AS value FROM read_parquet(?) "
                    f"WHERE {column} IS NOT NULL ORDER BY value",
                    [self.source],
                ).fetchall()
                categories[partition] = [str(row[0]) for row in rows]
            return {
                "rows": summary[0],
                "year_min": summary[1],
                "year_max": summary[2],
                "month_min": summary[3],
                "month_max": summary[4],
                "offset_ranges": {
                    "NDVI": summary[5],
                    "EVI": summary[6],
                    "MSAVI": summary[7],
                },
                "categories": categories,
                "offset_definition": "L8 - L7",
            }
        finally:
            connection.close()

    def query(self, request: SampleQuery, limit: int) -> dict[str, Any]:
        bbox = request.bbox
        clauses = [
            "longitude BETWEEN ? AND ?",
            "latitude BETWEEN ? AND ?",
        ]
        parameters: list[Any] = [bbox.west, bbox.east, bbox.south, bbox.north]
        if request.year is not None:
            clauses.append("image_year = ?")
            parameters.append(request.year)
        if request.month is not None:
            clauses.append("image_month = ?")
            parameters.append(request.month)
        if request.partition and request.partition != "conus" and request.category:
            clauses.append(f"{PARTITION_COLUMNS[request.partition]} = ?")
            parameters.append(request.category)
        where = " AND ".join(clauses)
        index_column = f"{request.index.lower()}_offset"
        connection = self._connection()
        try:
            if request.zoom < 8:
                cell_size = max(0.05, 12 / (2**request.zoom))
                sql = derived_cte(self.source) + f"""
                    SELECT
                        avg(longitude) AS longitude,
                        avg(latitude) AS latitude,
                        avg({index_column}) AS offset,
                        count(*) AS sample_count
                    FROM samples
                    WHERE {where} AND isfinite({index_column})
                    GROUP BY floor(longitude / {cell_size}), floor(latitude / {cell_size})
                    ORDER BY sample_count DESC
                    LIMIT ?
                """
                rows = connection.execute(sql, [*parameters, limit]).fetchall()
                features = [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [row[0], row[1]]},
                        "properties": {
                            "kind": "aggregate",
                            "offset": row[2],
                            "sample_count": row[3],
                        },
                    }
                    for row in rows
                ]
            else:
                sql = derived_cte(self.source) + f"""
                    SELECT longitude, latitude, leohs_id, image_year, image_month,
                           l7_date, l8_date, L7_image_id, L8_image_id,
                           l7_ndvi, l8_ndvi, ndvi_offset,
                           l7_evi, l8_evi, evi_offset,
                           l7_msavi, l8_msavi, msavi_offset,
                           b_offset, g_offset, r_offset, nir_offset, swir1_offset, swir2_offset,
                           ecoregion_l1_id, ecoregion_l1_name,
                           ecoregion_l2_id, ecoregion_l2_name,
                           ecoregion_l3_id, ecoregion_l3_name,
                           huc02_id, huc02_name, nlcd_landcover,
                           {index_column} AS offset
                    FROM samples
                    WHERE {where} AND isfinite({index_column})
                    LIMIT ?
                """
                cursor = connection.execute(sql, [*parameters, limit])
                columns = [item[0] for item in cursor.description]
                features = []
                for values in cursor.fetchall():
                    record = {column: json_value(value) for column, value in zip(columns, values)}
                    longitude = record.pop("longitude")
                    latitude = record.pop("latitude")
                    record["kind"] = "sample"
                    features.append(
                        {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
                            "properties": record,
                        }
                    )
            return {
                "type": "FeatureCollection",
                "features": features,
                "metadata": {
                    "mode": "aggregate" if request.zoom < 8 else "samples",
                    "truncated": len(features) >= limit,
                    "limit": limit,
                    "offset": request.index,
                },
            }
        finally:
            connection.close()


@lru_cache
def get_sample_store() -> SampleStore:
    return SampleStore(get_settings().sample_parquet)
