from __future__ import annotations

import json
import random
from functools import lru_cache
from pathlib import Path
from typing import Any

from .settings import get_settings


class CoefficientError(RuntimeError):
    pass


class CoefficientStore:
    def __init__(self, path: Path):
        self.path = path
        if not path.is_file():
            raise CoefficientError(
                f"Coefficient artifact not found at {path}. Run build-coefficients first."
            )
        self.data: dict[str, Any] = json.loads(path.read_text())

    @property
    def metadata(self) -> dict[str, Any]:
        return self.data["metadata"]

    def groups(self, partition: str, direction: str = "L7_to_L8") -> dict[str, Any]:
        return self.data["models"].get(direction, {}).get(partition, {})

    def regions(self, partition: str) -> list[dict[str, Any]]:
        return self.data.get("regions", {}).get(partition, [])

    def region(self, partition: str, group_id: str | int | None) -> dict[str, Any]:
        key = "CONUS" if partition == "conus" else str(group_id)
        region = next((item for item in self.regions(partition) if item["id"] == key), None)
        if region is None:
            raise CoefficientError(f"Unknown {partition} region: {key}")
        return region

    def empirical_group(
        self,
        partition: str,
        group_id: str | int | None,
        direction: str = "L7_to_L8",
    ) -> dict[str, Any]:
        key = "CONUS" if partition == "conus" else str(group_id)
        model = self.groups(partition, direction).get(key)
        if model is None:
            raise CoefficientError(
                f"Coefficients are unavailable for {direction}/{partition}/{key}"
            )
        return model

    def evaluation(
        self,
        partition: str,
        group_id: str | int | None,
        index: str,
        direction: str = "L7_to_L8",
    ) -> dict[str, Any]:
        key = "CONUS" if partition == "conus" else str(group_id)
        return (
            self.data.get("evaluations", {})
            .get(direction, {})
            .get(partition, {})
            .get(index, {})
            .get(key, {})
        )

    def random_point(self, partition: str, group_id: str | int | None) -> dict[str, float]:
        candidates = self.region(partition, group_id).get("candidates", [])
        if not candidates:
            raise CoefficientError(f"No map candidates are available for {partition}/{group_id}")
        return random.SystemRandom().choice(candidates)

    def group(
        self,
        partition: str,
        group_id: str | int | None,
        direction: str = "L7_to_L8",
    ) -> tuple[dict[str, Any], bool]:
        key = "CONUS" if partition == "conus" else str(group_id)
        model = self.groups(partition, direction).get(key)
        if model is not None:
            return model, False
        conus = self.groups("conus", direction).get("CONUS")
        if conus is None:
            raise CoefficientError(f"{direction} CONUS fallback coefficients are missing")
        return conus, True

    def coefficients(
        self,
        partition: str,
        group_id: str | int | None,
        method: str,
        metric: str,
        direction: str = "L7_to_L8",
    ) -> tuple[list[float], dict[str, Any], bool]:
        group, fallback = self.group(partition, group_id, direction)
        family, degree = method.split("_")
        degree_key = "1" if degree == "linear" else "3"
        model = group[family][degree_key][metric]
        return model["coefficients"], model, fallback


@lru_cache
def get_coefficient_store() -> CoefficientStore:
    return CoefficientStore(get_settings().coefficient_artifact)
