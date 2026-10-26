"""Score fixed parent coefficients on held-out observations in a child ecoregion."""
from __future__ import annotations

from functools import lru_cache
from typing import Any

from .coefficient_build import _coefficient_rows, _evaluation_query
from .coefficients import CoefficientStore, get_coefficient_store
from .query_limits import limit_parquet_queries
from .sample_store import SampleStore
from .settings import get_settings


class NestedEvaluationStore(SampleStore):
    def __init__(self, source: str, coefficients: CoefficientStore):
        super().__init__(source)
        self.coefficients = coefficients

    # Cache hits return without waiting for a parquet-query slot.
    @lru_cache(maxsize=128)
    @limit_parquet_queries
    def evaluate(
        self, parent_partition: str, parent_id: str, partition: str, group_id: str,
        index: str, direction: str,
    ) -> dict[str, Any]:
        # Load the existing parent and CONUS models only. Never fit child models.
        models = {direction: {
            "conus": {"CONUS": self.coefficients.empirical_group("conus", "CONUS", direction)},
            parent_partition: {parent_id: self.coefficients.empirical_group(parent_partition, parent_id, direction)},
        }}
        connection = self._connection()
        try:
            connection.execute(
                "CREATE TEMP TABLE coefficient_lookup "
                "(direction VARCHAR, partition VARCHAR, group_id VARCHAR, method VARCHAR, metric VARCHAR, "
                "c0 DOUBLE, c1 DOUBLE, c2 DOUBLE, c3 DOUBLE)"
            )
            connection.executemany(
                "INSERT INTO coefficient_lookup VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                _coefficient_rows(models),
            )
            query, _ = _evaluation_query(
                self.source, partition, index, direction,
                coefficient_partition=parent_partition, coefficient_group_id=parent_id,
                evaluation_group_id=group_id,
            )
            rows = connection.execute(query).fetchall()
        finally:
            connection.close()
        scored: dict[str, Any] = {}
        for _, alternative, bin_index, n, rmse, mean_difference in rows:
            metrics = scored.setdefault(alternative, {
                "n": 0, "rmse": None, "mean_difference": None,
                "bins": [{"bin": i, "lower": i / 10, "upper": (i + 1) / 10,
                          "n": 0, "mean_difference": None} for i in range(10)],
            })
            if bin_index == -1:
                metrics.update(n=int(n), rmse=float(rmse), mean_difference=float(mean_difference))
            else:
                metrics["bins"][bin_index].update(n=int(n), mean_difference=float(mean_difference))
        return scored


@lru_cache
def get_nested_evaluation_store() -> NestedEvaluationStore:
    return NestedEvaluationStore(get_settings().sample_parquet, get_coefficient_store())
