from __future__ import annotations

from harmonization_api.ee_pipeline import LandsatPipeline


class StoreStub:
    def empirical_group(self, partition: str, group_id: str | None, direction: str):
        assert partition == "ecoregion_l1"
        assert group_id == "8"
        assert direction == "L8_to_L7"
        return {
            "index": {
                "1": {"NDVI": {"coefficients": [0.125, 0.875]}},
                "3": {},
            }
        }


def test_fixed_selection_resolves_one_group_to_an_ee_constant(monkeypatch) -> None:
    pipeline = object.__new__(LandsatPipeline)
    pipeline.coefficient_store = StoreStub()
    observed: list[float] = []
    monkeypatch.setattr(
        "harmonization_api.ee_pipeline.ee.Image.constant",
        lambda value: observed.append(value) or ("constant", value),
    )

    result = pipeline._coefficient_image(
        partition="conus",
        method="index_linear",
        metric="NDVI",
        power=1,
        year=None,
        direction="L8_to_L7",
        fixed_partition="ecoregion_l1",
        fixed_group_id="8",
    )

    assert result == ("constant", 0.875)
    assert observed == [0.875]
