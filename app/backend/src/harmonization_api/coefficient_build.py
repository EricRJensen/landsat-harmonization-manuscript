from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import numpy as np

from .indices import BAND_NAMES, INDEX_NAMES, SQL_INDEX_EXPRESSIONS
from .published_coefficients import ROY_2016_ID, ROY_2016_OLS

DEFAULT_SOURCE = (
    Path(__file__).resolve().parents[4]
    / "data/external/SR_Landsatsamples_Covariates.parquet"
)
DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "artifacts" / "coefficients.json"
REPO_ROOT = Path(__file__).resolve().parents[4]
PARTITIONS = {
    "conus": ("'CONUS'", "'All CONUS pixels'"),
    "ecoregion_l1": ("ecoregion_l1_id", "ecoregion_l1_name"),
    "ecoregion_l2": ("ecoregion_l2_id", "ecoregion_l2_name"),
    "ecoregion_l3": ("ecoregion_l3_id", "ecoregion_l3_name"),
    "huc02": ("huc02_id", "huc02_name"),
    "nlcd": ("CAST(nlcd_landcover AS VARCHAR)", "CAST(nlcd_landcover AS VARCHAR)"),
}
DASHBOARD_PARTITIONS = ("conus", "ecoregion_l1", "ecoregion_l2", "ecoregion_l3", "huc02")
METHODS = ("band_linear", "band_cubic", "index_linear", "index_cubic")
DIRECTIONS = {
    "L7_to_L8": ("L7", "L8"),
    "L8_to_L7": ("L8", "L7"),
}
MANUSCRIPT_SAMPLE_FILTER = (
    "image_month BETWEEN 4 AND 10 "
    "AND nlcd_landcover IS NOT NULL "
    "AND ecoregion_l1_name IS NOT NULL"
)


def source_fingerprint(source: str) -> dict[str, Any]:
    path = Path(source)
    if not path.is_file():
        return {"uri": source, "sha256": None}
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    resolved = path.resolve()
    try:
        uri = str(resolved.relative_to(REPO_ROOT))
    except ValueError:
        uri = str(resolved)
    return {"uri": uri, "sha256": digest.hexdigest(), "bytes": path.stat().st_size}


def metric_rows_sql(direction: str) -> str:
    source_sensor, target_sensor = DIRECTIONS[direction]
    rows: list[str] = []
    for band in BAND_NAMES:
        rows.append(
            f"('band', '{band}', {source_sensor}_{band}, {target_sensor}_{band})"
        )
    for index in INDEX_NAMES:
        rows.append(
            f"('index', '{index}', {SQL_INDEX_EXPRESSIONS[index](source_sensor)}, "
            f"{SQL_INDEX_EXPRESSIONS[index](target_sensor)})"
        )
    return ",\n".join(rows)


def moments_query(source: str, partition: str, direction: str) -> str:
    group_expression, name_expression = PARTITIONS[partition]
    escaped = source.replace("'", "''")
    return f"""
        WITH source AS MATERIALIZED (
            SELECT *,
                {group_expression} AS group_id,
                {name_expression} AS group_name,
                CASE WHEN split < 0.7 THEN 'train' ELSE 'validation' END AS phase
            FROM read_parquet('{escaped}')
            WHERE {MANUSCRIPT_SAMPLE_FILTER}
        ), long AS (
            SELECT group_id, group_name, phase, metric_family, metric, x, y
            FROM source
            CROSS JOIN LATERAL (VALUES
                {metric_rows_sql(direction)}
            ) metrics(metric_family, metric, x, y)
            WHERE group_id IS NOT NULL AND isfinite(x) AND isfinite(y)
        )
        SELECT
            CAST(group_id AS VARCHAR) AS group_id,
            any_value(CAST(group_name AS VARCHAR)) AS group_name,
            phase,
            metric_family,
            metric,
            count(*)::BIGINT AS n,
            min(x)::DOUBLE AS x_min,
            max(x)::DOUBLE AS x_max,
            sum(y)::DOUBLE AS sy,
            sum(y * y)::DOUBLE AS sy2,
            sum(x)::DOUBLE AS sx1,
            sum(pow(x, 2))::DOUBLE AS sx2,
            sum(pow(x, 3))::DOUBLE AS sx3,
            sum(pow(x, 4))::DOUBLE AS sx4,
            sum(pow(x, 5))::DOUBLE AS sx5,
            sum(pow(x, 6))::DOUBLE AS sx6,
            sum(y)::DOUBLE AS sxy0,
            sum(x * y)::DOUBLE AS sxy1,
            sum(pow(x, 2) * y)::DOUBLE AS sxy2,
            sum(pow(x, 3) * y)::DOUBLE AS sxy3
        FROM long
        GROUP BY group_id, phase, metric_family, metric
        ORDER BY group_id, metric_family, metric, phase
    """


def moment_vector(row: dict[str, Any]) -> list[float]:
    return [float(row["n"]), *[float(row[f"sx{i}"]) for i in range(1, 7)]]


def fit_from_moments(row: dict[str, Any], degree: int) -> tuple[np.ndarray, float]:
    sx = moment_vector(row)
    matrix = np.array(
        [[sx[i + j] for j in range(degree + 1)] for i in range(degree + 1)],
        dtype=float,
    )
    rhs = np.array([float(row[f"sxy{i}"]) for i in range(degree + 1)], dtype=float)
    condition = float(np.linalg.cond(matrix))
    coefficients = np.linalg.pinv(matrix, rcond=1e-12) @ rhs
    return coefficients, condition


def diagnostics(row: dict[str, Any], coefficients: np.ndarray) -> dict[str, float | int | None]:
    degree = len(coefficients) - 1
    sx = moment_vector(row)
    sy = float(row["sy"])
    sy2 = float(row["sy2"])
    sxy = [float(row[f"sxy{i}"]) for i in range(degree + 1)]
    n = int(row["n"])
    prediction_sum = sum(coefficients[i] * sx[i] for i in range(degree + 1))
    sse = sy2 - 2 * sum(coefficients[i] * sxy[i] for i in range(degree + 1))
    sse += sum(
        coefficients[i] * coefficients[j] * sx[i + j]
        for i in range(degree + 1)
        for j in range(degree + 1)
    )
    sse = max(float(sse), 0.0)
    sst = sy2 - sy * sy / n if n else 0.0
    return {
        "n": n,
        "rmse": float(np.sqrt(sse / n)) if n else None,
        "bias": float((prediction_sum - sy) / n) if n else None,
        "r_squared": float(1 - sse / sst) if sst > 0 else None,
    }


def _coefficient_rows(models: dict[str, Any]) -> list[tuple[Any, ...]]:
    rows: list[tuple[Any, ...]] = []
    for direction, partitions in models.items():
        for partition, groups in partitions.items():
            for group_id, group in groups.items():
                for family in ("band", "index"):
                    for degree, degree_name in (("1", "linear"), ("3", "cubic")):
                        for metric, model in group[family][degree].items():
                            values = [*model["coefficients"], 0.0, 0.0, 0.0, 0.0][:4]
                            rows.append(
                                (
                                    direction,
                                    partition,
                                    str(group_id),
                                    f"{family}_{degree_name}",
                                    metric,
                                    *values,
                                )
                            )
    return rows


def _polynomial_sql(value: str, alias: str, cubic: bool) -> str:
    expression = f"{alias}.c0 + {alias}.c1 * ({value})"
    if cubic:
        expression += f" + {alias}.c2 * pow(({value}), 2) + {alias}.c3 * pow(({value}), 3)"
    return expression


def _index_sql(index: str, bands: dict[str, str]) -> str:
    blue, red, nir = bands["B"], bands["R"], bands["NIR"]
    if index == "NDVI":
        return f"(({nir}) - ({red})) / nullif(({nir}) + ({red}), 0)"
    if index == "EVI":
        return f"2.5 * (({nir}) - ({red})) / nullif(({nir}) + 6 * ({red}) - 7.5 * ({blue}) + 1, 0)"
    radicand = f"pow(2 * ({nir}) + 1, 2) - 8 * (({nir}) - ({red}))"
    return f"CASE WHEN {radicand} >= 0 THEN (2 * ({nir}) + 1 - sqrt({radicand})) / 2 END"


def _prediction_branch(
    partition: str,
    index: str,
    method: str,
    source: str,
    direction: str,
) -> str:
    source_sensor, _ = DIRECTIONS[direction]
    family, degree_name = method.split("_")
    cubic = degree_name == "cubic"
    group_condition = "'CONUS'" if source == "conus" else "b.group_id"
    prefix = f"{source[:1]}_{method.replace('_', '')}"
    joins: list[str] = []
    if family == "index":
        alias = f"{prefix}_i"
        joins.append(
            f"JOIN coefficient_lookup {alias} ON {alias}.direction = '{direction}' "
            f"AND {alias}.partition = '{source if source == 'conus' else partition}' "
            f"AND {alias}.group_id = {group_condition} AND {alias}.method = '{method}' "
            f"AND {alias}.metric = '{index}'"
        )
        prediction = _polynomial_sql("b.source_index", alias, cubic)
    else:
        transformed: dict[str, str] = {}
        for band in BAND_NAMES:
            alias = f"{prefix}_{band.lower()}"
            joins.append(
                f"JOIN coefficient_lookup {alias} ON {alias}.direction = '{direction}' "
                f"AND {alias}.partition = '{source if source == 'conus' else partition}' "
                f"AND {alias}.group_id = {group_condition} AND {alias}.method = '{method}' "
                f"AND {alias}.metric = '{band}'"
            )
            transformed[band] = _polynomial_sql(f"b.{source_sensor}_{band}", alias, cubic)
        prediction = _index_sql(index, transformed)
    alternative = f"{source}_{method}"
    return (
        f"SELECT b.rid, b.group_id, b.source_index, b.target_index, '{alternative}' AS alternative, "
        f"({prediction})::DOUBLE AS prediction FROM base b {' '.join(joins)}"
    )


def _evaluation_query(
    source_path: str,
    partition: str,
    index: str,
    direction: str,
) -> tuple[str, int]:
    group_expression, _ = PARTITIONS[partition]
    escaped = source_path.replace("'", "''")
    source_sensor, target_sensor = DIRECTIONS[direction]
    source_index = SQL_INDEX_EXPRESSIONS[index](source_sensor)
    target_index = SQL_INDEX_EXPRESSIONS[index](target_sensor)
    branches = [
        "SELECT rid, group_id, source_index, target_index, 'unharmonized' AS alternative, "
        "source_index AS prediction FROM base"
    ]
    roy_bands = {
        band: f"({intercept} + {slope} * b.{source_sensor}_{band})"
        for band, (intercept, slope) in ROY_2016_OLS[direction].items()
    }
    branches.append(
        f"SELECT b.rid, b.group_id, b.source_index, b.target_index, '{ROY_2016_ID}' AS alternative, "
        f"({_index_sql(index, roy_bands)})::DOUBLE AS prediction FROM base b"
    )
    for method in METHODS:
        branches.append(_prediction_branch(partition, index, method, "conus", direction))
    if partition != "conus":
        for method in METHODS:
            branches.append(_prediction_branch(partition, index, method, partition, direction))
    expected = len(branches)
    return f"""
        WITH base AS MATERIALIZED (
            SELECT row_number() OVER () AS rid, CAST({group_expression} AS VARCHAR) AS group_id,
                   ({source_index})::DOUBLE AS source_index, ({target_index})::DOUBLE AS target_index,
                   {', '.join(f'{source_sensor}_{band}' for band in BAND_NAMES)}
            FROM read_parquet('{escaped}')
            WHERE {MANUSCRIPT_SAMPLE_FILTER} AND split >= 0.7
              AND {group_expression} IS NOT NULL
              AND isfinite({source_index}) AND isfinite({target_index})
              AND ({source_index}) BETWEEN 0 AND 1
        ), predictions AS MATERIALIZED (
            {' UNION ALL '.join(branches)}
        ), valid_rows AS (
            SELECT group_id, rid
            FROM predictions
            GROUP BY group_id, rid
            HAVING count(*) = {expected} AND bool_and(isfinite(prediction))
        ), scored AS (
            SELECT p.*,
                   CASE WHEN source_index = 0 THEN 0
                        WHEN source_index > 0 AND source_index <= 1
                        THEN least(9, CAST(ceil(source_index * 10) - 1 AS INTEGER)) END AS bin
            FROM predictions p JOIN valid_rows v USING (group_id, rid)
        )
        SELECT group_id, alternative,
               CASE WHEN grouping(bin) = 1 THEN -1 ELSE bin END AS bin,
               count(*)::BIGINT AS n,
               sqrt(avg(pow(prediction - target_index, 2)))::DOUBLE AS rmse,
               avg(prediction - target_index)::DOUBLE AS mean_difference
        FROM scored
        GROUP BY GROUPING SETS ((group_id, alternative), (group_id, alternative, bin))
        HAVING grouping(bin) = 1 OR bin IS NOT NULL
        ORDER BY group_id, alternative, bin
    """, expected


def build_empirical_summaries(
    connection: duckdb.DuckDBPyConnection | None,
    source: str,
    models: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    owned = connection is None
    connection = connection or duckdb.connect()
    connection.execute("SET threads=4")
    connection.execute("SET preserve_insertion_order=false")
    connection.execute(
        "CREATE OR REPLACE TEMP TABLE coefficient_lookup "
        "(direction VARCHAR, partition VARCHAR, group_id VARCHAR, method VARCHAR, metric VARCHAR, "
        "c0 DOUBLE, c1 DOUBLE, c2 DOUBLE, c3 DOUBLE)"
    )
    connection.executemany(
        "INSERT INTO coefficient_lookup VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        _coefficient_rows(models),
    )
    escaped = source.replace("'", "''")
    catalogs: dict[str, Any] = {}
    evaluations: dict[str, Any] = {}
    try:
        for partition in DASHBOARD_PARTITIONS:
            group_expression, name_expression = PARTITIONS[partition]
            rows = connection.execute(f"""
                SELECT CAST({group_expression} AS VARCHAR) AS group_id,
                       any_value(CAST({name_expression} AS VARCHAR)) AS group_name,
                       count(*)::BIGINT AS sample_count,
                       count(*) FILTER (WHERE split < 0.7)::BIGINT AS training_count,
                       count(*) FILTER (WHERE split >= 0.7)::BIGINT AS validation_count,
                       arg_min(
                           struct_pack(longitude := longitude, latitude := latitude),
                           hash(coalesce(leohs_id, ''), longitude, latitude), 64
                       ) FILTER (WHERE longitude BETWEEN -125 AND -66 AND latitude BETWEEN 24 AND 50)
                         AS candidates
                FROM read_parquet('{escaped}')
                WHERE {MANUSCRIPT_SAMPLE_FILTER} AND {group_expression} IS NOT NULL
                GROUP BY group_id ORDER BY group_name, group_id
            """).fetchall()
            catalogs[partition] = [
                {
                    "id": str(group_id),
                    "name": str(group_name),
                    "sample_count": int(sample_count),
                    "training_count": int(training_count),
                    "validation_count": int(validation_count),
                    "candidates": [
                        {"longitude": float(point["longitude"]), "latitude": float(point["latitude"])}
                        for point in (candidates or [])
                    ],
                }
                for group_id, group_name, sample_count, training_count, validation_count, candidates in rows
            ]
        for direction in DIRECTIONS:
            evaluations[direction] = {}
            for partition in DASHBOARD_PARTITIONS:
                evaluations[direction][partition] = {}
                for index in INDEX_NAMES:
                    query, expected = _evaluation_query(source, partition, index, direction)
                    metric_rows = connection.execute(query).fetchall()
                    by_group: dict[str, Any] = {}
                    for group_id, alternative, bin_index, n, rmse, mean_difference in metric_rows:
                        group = by_group.setdefault(str(group_id), {})
                        item = group.setdefault(
                            alternative,
                            {"n": 0, "rmse": None, "mean_difference": None, "bins": []},
                        )
                        if int(bin_index) == -1:
                            item.update(n=int(n), rmse=float(rmse), mean_difference=float(mean_difference))
                        else:
                            item["bins"].append(
                                {
                                    "bin": int(bin_index),
                                    "lower": int(bin_index) / 10,
                                    "upper": (int(bin_index) + 1) / 10,
                                    "n": int(n),
                                    "mean_difference": float(mean_difference),
                                }
                            )
                    for group in by_group.values():
                        for item in group.values():
                            present = {entry["bin"] for entry in item["bins"]}
                            item["bins"].extend(
                                {"bin": bin_index, "lower": bin_index / 10, "upper": (bin_index + 1) / 10,
                                 "n": 0, "mean_difference": None}
                                for bin_index in range(10) if bin_index not in present
                            )
                            item["bins"].sort(key=lambda entry: entry["bin"])
                    evaluations[direction][partition][index] = by_group
                    if any(len(group) != expected for group in by_group.values()):
                        raise RuntimeError(
                            f"Incomplete evaluation alternatives for {direction}/{partition}/{index}"
                        )
    finally:
        if owned:
            connection.close()
    return catalogs, evaluations


def build_artifact(source: str, minimum_n: int = 1_000) -> dict[str, Any]:
    connection = duckdb.connect()
    connection.execute("SET threads=4")
    connection.execute("SET preserve_insertion_order=false")
    models: dict[str, Any] = {}
    try:
        for direction in DIRECTIONS:
            models[direction] = {}
            for partition in PARTITIONS:
                cursor = connection.execute(moments_query(source, partition, direction))
                columns = [description[0] for description in cursor.description]
                records = [dict(zip(columns, values)) for values in cursor.fetchall()]
                by_key = {
                    (record["group_id"], record["metric_family"], record["metric"], record["phase"]): record
                    for record in records
                }
                groups: dict[str, Any] = {}
                for group_id, family, metric, phase in by_key:
                    if phase != "train":
                        continue
                    train = by_key[(group_id, family, metric, "train")]
                    if int(train["n"]) < minimum_n or train["x_min"] == train["x_max"]:
                        continue
                    group = groups.setdefault(
                        group_id,
                        {"name": train["group_name"], "band": {"1": {}, "3": {}}, "index": {"1": {}, "3": {}}},
                    )
                    for degree in (1, 3):
                        coefficients, condition = fit_from_moments(train, degree)
                        validation = by_key.get((group_id, family, metric, "validation"))
                        model = {
                            "coefficients": [float(value) for value in coefficients],
                            "n": int(train["n"]),
                            "predictor_min": float(train["x_min"]),
                            "predictor_max": float(train["x_max"]),
                            "condition_number": condition,
                            "training": diagnostics(train, coefficients),
                            "validation": diagnostics(validation, coefficients) if validation else None,
                        }
                        group[family][str(degree)][metric] = model
                complete_groups = {
                    group_id: group
                    for group_id, group in groups.items()
                    if all(
                        len(group[family][str(degree)]) == (6 if family == "band" else 3)
                        for family in ("band", "index")
                        for degree in (1, 3)
                    )
                }
                models[direction][partition] = complete_groups
    finally:
        connection.close()

    for direction in DIRECTIONS:
        if "CONUS" not in models.get(direction, {}).get("conus", {}):
            raise RuntimeError(f"The build did not produce complete {direction} CONUS coefficients")
    catalogs, evaluations = build_empirical_summaries(connection=None, source=source, models=models)
    return {
        "metadata": {
            "schema_version": 4,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": source_fingerprint(source),
            "directions": {
                "L7_to_L8": {
                    "source": "Landsat 7 ETM+",
                    "target": "Landsat 8 OLI",
                    "mean_difference": "transformed L7 minus observed L8",
                },
                "L8_to_L7": {
                    "source": "Landsat 8 OLI",
                    "target": "Landsat 7 ETM+",
                    "mean_difference": "transformed L8 minus observed L7",
                },
            },
            "training_filter": (
                "split < 0.7; image_month in 4..10; nonmissing NLCD and Level I ecoregion"
            ),
            "validation_filter": (
                "split >= 0.7; image_month in 4..10; nonmissing NLCD and Level I ecoregion"
            ),
            "minimum_n": minimum_n,
            "unavailable_strata_fallback": "CONUS (legacy dynamic-map workflow only)",
            "empirical_fallback_to_conus": False,
            "evaluation_rule": (
                "manuscript validation filter; finite source and target indices; "
                "unharmonized source index in [0,1]"
            ),
            "published_benchmarks": {
                ROY_2016_ID: {
                    "citation": "Roy et al. (2016)",
                    "regression_type": "OLS",
                    "family": "band",
                    "coefficients": ROY_2016_OLS,
                }
            },
            "bins": [f"({i / 10:.1f},{(i + 1) / 10:.1f}]" for i in range(10)],
            "polynomial_outputs_clamped": False,
        },
        "models": models,
        "regions": catalogs,
        "evaluations": evaluations,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit versioned Landsat harmonization coefficients")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--minimum-n", type=int, default=1_000)
    args = parser.parse_args()
    artifact = build_artifact(args.source, args.minimum_n)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {args.output} with " + "; ".join(
        f"{direction}: " + ", ".join(
            f"{partition}={len(groups)}" for partition, groups in partitions.items()
        )
        for direction, partitions in artifact["models"].items()
    ))


if __name__ == "__main__":
    main()
