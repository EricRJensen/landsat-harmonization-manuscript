from __future__ import annotations

from collections import defaultdict
from functools import lru_cache
from typing import Any

import numpy as np
from scipy.stats import kendalltau, theilslopes

from .coefficients import get_coefficient_store
from .ee_pipeline import LandsatPipeline
from .settings import get_settings


@lru_cache
def get_pipeline() -> LandsatPipeline:
    return LandsatPipeline(get_settings(), get_coefficient_store())


def trend_summary(values: list[dict[str, Any]], value_key: str) -> dict[str, Any] | None:
    valid = [(int(item["year"]), item.get(value_key)) for item in values if item.get(value_key) is not None]
    if len(valid) < 8:
        return None
    years = np.array([item[0] for item in valid], dtype=float)
    observations = np.array([item[1] for item in valid], dtype=float)
    slope = theilslopes(observations, years)
    tau = kendalltau(years, observations)
    return {
        "slope": float(slope.slope),
        "intercept": float(slope.intercept),
        "tau": float(tau.statistic),
        "p_value": float(tau.pvalue),
        "n": len(valid),
    }


def format_timeseries(rows: list[dict[str, Any]], include_harmonized_sensors: bool) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for source_row in rows:
        # ``time_series`` is cached. Never mutate its rows while shaping a response,
        # otherwise a repeated request fails after the first response removes these
        # properties from the cached dictionaries.
        row = dict(source_row)
        series = row.pop("series")
        if series != "merged" and not include_harmonized_sensors:
            row.pop("harm", None)
        grouped[series].append(row)
    for values in grouped.values():
        values.sort(key=lambda item: item["year"])
    merged = grouped.get("merged", [])
    return {
        "series": dict(grouped),
        "trends": {
            "raw": trend_summary(merged, "raw"),
            "harmonized": trend_summary(merged, "harm"),
        },
    }


def format_polygon_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    result = format_timeseries(payload["rows"], include_harmonized_sensors=False)
    distributions: dict[str, Any] = {}
    for source, summary in payload.get("trend_distributions", {}).items():
        counts = {
            str(key): int(value)
            for key, value in (summary.get("classes") or {}).items()
        }
        total = sum(counts.values())
        distributions[source] = {
            "boxplot": summary.get("boxplot") or {},
            "class_percentages": {
                key: (100 * counts.get(key, 0) / total if total else 0.0)
                for key in ("-3", "-2", "-1", "1", "2", "3")
            },
            "pixel_count": total,
        }
    result["trend_distributions"] = distributions
    return result
