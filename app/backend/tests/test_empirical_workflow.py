from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from harmonization_api.coefficients import CoefficientStore
from harmonization_api.main import api


ARTIFACT = Path(__file__).resolve().parents[1] / "artifacts" / "coefficients.json"


def test_artifact_has_requested_region_catalogs_and_common_validation_population() -> None:
    store = CoefficientStore(ARTIFACT)
    assert store.metadata["schema_version"] == 3
    assert {partition: len(store.regions(partition)) for partition in (
        "ecoregion_l1", "ecoregion_l2", "ecoregion_l3", "huc02"
    )} == {"ecoregion_l1": 10, "ecoregion_l2": 20, "ecoregion_l3": 85, "huc02": 18}

    group_id = store.regions("ecoregion_l1")[0]["id"]
    for direction in ("L7_to_L8", "L8_to_L7"):
        alternatives = store.evaluation("ecoregion_l1", group_id, "NDVI", direction)
        assert len(alternatives) == 10
        assert len({item["n"] for item in alternatives.values()}) == 1
        assert all(len(item["bins"]) == 10 for item in alternatives.values())
    assert (
        store.metadata["directions"]["L8_to_L7"]["mean_difference"]
        == "transformed L8 minus observed L7"
    )


def test_empirical_endpoints_report_no_fallback_and_valid_random_candidate() -> None:
    client = TestClient(api)
    catalog = client.get("/api/v1/regions", params={"partition": "ecoregion_l1"})
    assert catalog.status_code == 200
    group_id = catalog.json()["regions"][0]["id"]

    for direction in ("L7_to_L8", "L8_to_L7"):
        response = client.get(
            f"/api/v1/evaluations/ecoregion_l1/{group_id}",
            params={"index": "EVI", "direction": direction},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["direction"] == direction
        assert body["fallback_to_conus"] is False
        assert len(body["alternatives"]) == 10
        assert all(item["available"] for item in body["alternatives"])
        roy = next(item for item in body["alternatives"] if item["id"] == "roy_2016_band_ols")
        assert roy["source"] == "published"
        assert roy["regression_type"] == "OLS"
        expected_blue = [0.0003, 0.8474] if direction == "L7_to_L8" else [0.0183, 0.885]
        assert roy["models"]["B"]["coefficients"] == expected_blue

    candidate = client.get(f"/api/v1/regions/ecoregion_l1/{group_id}/random-point")
    assert candidate.status_code == 200
    point = candidate.json()["point"]
    assert -125 <= point["longitude"] <= -66
    assert 24 <= point["latitude"] <= 50
    assert candidate.json()["zoom"] == 10
