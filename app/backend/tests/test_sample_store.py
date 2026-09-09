from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from harmonization_api.sample_store import SampleStore
from harmonization_api.schemas import BoundingBox, SampleQuery


def make_sample(path: Path) -> None:
    duckdb.connect().execute(
        """
        COPY (
          SELECT 'id' leohs_id, -120.0 longitude, 40.0 latitude,
            2018 image_year, 7 image_month,
            'LANDSAT/LE07/C02/T1_L2/LE07_000000_20180701' L7_image_id,
            'LANDSAT/LC08/C02/T1_L2/LC08_000000_20180702' L8_image_id,
            0.1 L7_B, 0.2 L7_G, 0.2 L7_R, 0.6 L7_NIR, 0.3 L7_SWIR1, 0.25 L7_SWIR2,
            0.11 L8_B, 0.21 L8_G, 0.22 L8_R, 0.64 L8_NIR, 0.31 L8_SWIR1, 0.27 L8_SWIR2,
            '8' ecoregion_l1_id, 'Test L1' ecoregion_l1_name,
            '9.1' ecoregion_l2_id, 'Test L2' ecoregion_l2_name,
            '1' ecoregion_l3_id, 'Test L3' ecoregion_l3_name,
            '01' huc02_id, 'Test HUC' huc02_name, 71 nlcd_landcover
        ) TO ? (FORMAT PARQUET)
        """,
        [str(path)],
    )


def test_individual_sample_offsets_and_dates(tmp_path: Path) -> None:
    source = tmp_path / "samples.parquet"
    make_sample(source)
    store = SampleStore(str(source))
    result = store.query(
        SampleQuery(
            bbox=BoundingBox(west=-121, south=39, east=-119, north=41), zoom=10, index="NDVI"
        ),
        100,
    )
    properties = result["features"][0]["properties"]
    assert properties["l7_date"] == "20180701"
    assert properties["l8_date"] == "20180702"
    assert properties["r_offset"] == pytest.approx(0.02)
    assert properties["ndvi_offset"] == pytest.approx(
        (0.64 - 0.22) / (0.64 + 0.22) - (0.6 - 0.2) / (0.6 + 0.2)
    )
