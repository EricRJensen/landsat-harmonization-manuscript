#!/usr/bin/env python3
"""Calculate view-direction statistics for paired Landsat 7/8 observations."""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path
from typing import Iterable, Sequence

import duckdb


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PACKAGE_ROOT / "data/external/SR_Landsatsamples_Covariates.parquet"
DEFAULT_OUTPUT_DIR = PACKAGE_ROOT / "output/tables"

BANDS = (
    ("Blue", "L7_B", "L8_B"),
    ("Green", "L7_G", "L8_G"),
    ("Red", "L7_R", "L8_R"),
    ("NIR", "L7_NIR", "L8_NIR"),
    ("SWIR1", "L7_SWIR1", "L8_SWIR1"),
    ("SWIR2", "L7_SWIR2", "L8_SWIR2"),
)

# These fields represent the ancillary datasets used by the analysis. Requiring
# all of them reproduces the documented 3,285,686-observation training set.
ANCILLARY_COLUMNS = (
    "L7_SR_ATMOS_OPACITY",
    "L8_SR_QA_AEROSOL",
    "elevation_m",
    "nlcd_landcover",
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

# The parquet has no stored index columns, so these reproduce the formulas in
# app/backend/src/harmonization_api/indices.py. Reflectances are already scaled
# to fractions. NULLIF handles zero denominators, and the CASE protects MSAVI's
# square root from a negative radicand.
INDICES = (
    (
        "NDVI",
        "(L7_NIR - L7_R) / nullif(L7_NIR + L7_R, 0)",
        "(L8_NIR - L8_R) / nullif(L8_NIR + L8_R, 0)",
    ),
    (
        "EVI",
        "2.5 * (L7_NIR - L7_R) / "
        "nullif(L7_NIR + 6 * L7_R - 7.5 * L7_B + 1, 0)",
        "2.5 * (L8_NIR - L8_R) / "
        "nullif(L8_NIR + 6 * L8_R - 7.5 * L8_B + 1, 0)",
    ),
    (
        "MSAVI",
        "CASE WHEN pow(2 * L7_NIR + 1, 2) - 8 * (L7_NIR - L7_R) >= 0 "
        "THEN (2 * L7_NIR + 1 - sqrt(pow(2 * L7_NIR + 1, 2) "
        "- 8 * (L7_NIR - L7_R))) / 2 END",
        "CASE WHEN pow(2 * L8_NIR + 1, 2) - 8 * (L8_NIR - L8_R) >= 0 "
        "THEN (2 * L8_NIR + 1 - sqrt(pow(2 * L8_NIR + 1, 2) "
        "- 8 * (L8_NIR - L8_R))) / 2 END",
    ),
)

HEADERS = (
    "variable",
    "total_n",
    "n_w",
    "n_e",
    "naive_bias",
    "m_w",
    "m_e",
    "symmetric_offset",
    "antisymmetric_angular",
    "angular_to_offset_ratio",
)


def sql_string(value: str | Path) -> str:
    """Return a safely quoted DuckDB string literal."""
    return "'" + str(value).replace("'", "''") + "'"


def metric_values(metrics: Iterable[tuple[str, str, str]]) -> str:
    return ",\n".join(
        f"({sql_string(name)}, ({l7_expression}), ({l8_expression}))"
        for name, l7_expression, l8_expression in metrics
    )


def complete_ancillary_sql() -> str:
    return " AND ".join(f"{column} IS NOT NULL" for column in ANCILLARY_COLUMNS)


def stats_query(source: Path, metrics: Iterable[tuple[str, str, str]]) -> str:
    """Build the aggregate query for one metric family.

    The source has no VZA columns. The project's existing analysis derives the
    relative swath direction from acquisition dates: L8 one day after L7 means
    "L8 west of L7," while L8 one day before L7 means the reverse. Only the
    sign is needed here, so delta_vza is a sign proxy defined as
    L7 acquisition date minus L8 acquisition date (in days). Consequently,
    delta_vza < 0 is the west group and delta_vza > 0 is the east group.

    Every radiometric difference uses the requested OLI-minus-ETM+ convention:
    difference = L8 value - L7 value.
    """
    return f"""
        WITH training AS MATERIALIZED (
            SELECT *,
                -date_diff(
                    'day',
                    strptime(right(L7_image_id, 8), '%Y%m%d'),
                    strptime(right(L8_image_id, 8), '%Y%m%d')
                ) AS delta_vza
            FROM read_parquet({sql_string(source)})
            WHERE split < 0.7
                AND image_month BETWEEN 4 AND 10
                AND {complete_ancillary_sql()}
        ), differences AS (
            SELECT variable, delta_vza, oli_value - etm_value AS difference
            FROM training
            CROSS JOIN LATERAL (VALUES
                {metric_values(metrics)}
            ) values_by_metric(variable, etm_value, oli_value)
            WHERE isfinite(etm_value) AND isfinite(oli_value)
        ), means AS (
            SELECT
                variable,
                count(*)::BIGINT AS total_n,
                count(*) FILTER (WHERE delta_vza < 0)::BIGINT AS west_n,
                count(*) FILTER (WHERE delta_vza > 0)::BIGINT AS east_n,
                avg(difference)::DOUBLE AS naive_bias,
                avg(difference) FILTER (WHERE delta_vza < 0)::DOUBLE AS m_w,
                avg(difference) FILTER (WHERE delta_vza > 0)::DOUBLE AS m_e
            FROM differences
            WHERE isfinite(difference)
            GROUP BY variable
        )
        SELECT
            variable,
            total_n,
            west_n,
            east_n,
            naive_bias,
            m_w,
            m_e,
            ((m_w + m_e) / 2)::DOUBLE AS symmetric_offset,
            ((m_e - m_w) / 2)::DOUBLE AS antisymmetric_angular,
            (abs((m_e - m_w) / 2) /
                nullif(abs((m_w + m_e) / 2), 0))::DOUBLE AS angular_to_offset_ratio
        FROM means
        ORDER BY CASE variable
            {" ".join(f"WHEN {sql_string(name)} THEN {position}" for position, (name, _, __) in enumerate(metrics))}
        END
    """


def validate_source(connection: duckdb.DuckDBPyConnection, source: Path) -> tuple[int, int]:
    """Validate the existing split and the date-based viewing-direction proxy."""
    if not source.is_file():
        raise FileNotFoundError(f"Input parquet does not exist: {source}")

    columns = {
        row[0]
        for row in connection.execute(
            f"DESCRIBE SELECT * FROM read_parquet({sql_string(source)})"
        ).fetchall()
    }
    required = {
        "split",
        "image_month",
        "L7_image_id",
        "L8_image_id",
        *(column for _, l7, l8 in BANDS for column in (l7, l8)),
        *ANCILLARY_COLUMNS,
    }
    missing = sorted(required - columns)
    if missing:
        raise ValueError(f"Input parquet is missing required columns: {', '.join(missing)}")

    training_n, invalid_direction_n = connection.execute(
        f"""
        SELECT
            count(*)::BIGINT,
            count(*) FILTER (
                WHERE date_diff(
                    'day',
                    strptime(right(L7_image_id, 8), '%Y%m%d'),
                    strptime(right(L8_image_id, 8), '%Y%m%d')
                ) NOT IN (-1, 1)
            )::BIGINT
        FROM read_parquet({sql_string(source)})
        WHERE split < 0.7
            AND image_month BETWEEN 4 AND 10
            AND {complete_ancillary_sql()}
        """
    ).fetchone()
    if invalid_direction_n:
        raise ValueError(
            f"Found {invalid_direction_n:,} training rows without an expected "
            "one-day L7/L8 acquisition offset; their view-direction sign is ambiguous."
        )
    return training_n, invalid_direction_n


def write_csv(path: Path, rows: Sequence[Sequence[object]]) -> None:
    """Write native numeric values without display rounding."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(HEADERS)
        writer.writerows(rows)


def display_value(value: object) -> str:
    if value is None:
        return "NA"
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, float):
        if math.isfinite(value):
            return f"{value:.6f}"
        return str(value)
    return str(value)


def print_table(title: str, rows: Sequence[Sequence[object]]) -> None:
    displayed = [[display_value(value) for value in row] for row in rows]
    short_headers = ("Variable", "Total n", "n west", "n east", "Bias", "m_w", "m_e", "Offset", "Angular", "Ratio")
    widths = [
        max(len(short_headers[index]), *(len(row[index]) for row in displayed))
        for index in range(len(short_headers))
    ]
    print(f"\n{title}")
    print("  ".join(header.ljust(widths[index]) for index, header in enumerate(short_headers)))
    print("  ".join("-" * width for width in widths))
    for row in displayed:
        print("  ".join(value.ljust(widths[index]) for index, value in enumerate(row)))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = args.source.resolve()
    output_dir = args.output_dir.resolve()
    connection = duckdb.connect()
    try:
        training_n, _ = validate_source(connection, source)
        band_rows = connection.execute(stats_query(source, BANDS)).fetchall()
        index_rows = connection.execute(stats_query(source, INDICES)).fetchall()
    finally:
        connection.close()

    band_output = output_dir / "table_s03_band_view_geometry.csv"
    index_output = output_dir / "table_s04_index_view_geometry.csv"
    write_csv(band_output, band_rows)
    write_csv(index_output, index_rows)

    print(f"Source: {source}")
    print(
        "Training filter: split < 0.7, image_month between 4 and 10, "
        "and complete ancillary data"
    )
    print(f"Training rows: {training_n:,}")
    print("Difference convention: OLI (L8) - ETM+ (L7)")
    print("Viewing sign: delta_vza < 0 = L8 west of L7; delta_vza > 0 = L8 east of L7")
    print_table("Band angular statistics (rounded for display)", band_rows)
    print_table("Index angular statistics (rounded for display)", index_rows)
    print(f"\nWrote full-precision CSVs:\n  {band_output}\n  {index_output}")


if __name__ == "__main__":
    main()
