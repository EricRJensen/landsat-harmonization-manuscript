from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Event

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


def test_config_reuses_scan_and_returns_independent_metadata(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "samples.parquet"
    make_sample(source)
    store = SampleStore(str(source))
    connect = store._connection
    calls = []

    def counted_connection():
        calls.append(1)
        return connect()

    monkeypatch.setattr(store, "_connection", counted_connection)
    first = store.config()
    second = store.config()

    assert first == second
    assert calls == [1]
    assert second["rows"] == 1
    assert second["year_min"] == second["year_max"] == 2018
    assert second["month_min"] == second["month_max"] == 7
    assert second["offset_definition"] == "L8 - L7"
    assert set(second["offset_ranges"]) == {"NDVI", "EVI", "MSAVI"}
    assert second["categories"] == {
        "ecoregion_l1": ["8"], "ecoregion_l2": ["9.1"],
        "ecoregion_l3": ["1"], "huc02": ["01"], "nlcd": ["71"],
    }
    first["categories"]["huc02"].append("02")
    first["offset_ranges"]["NDVI"][0] = 999
    assert store.config() == second


def test_concurrent_config_requests_share_one_scan(monkeypatch) -> None:
    store = SampleStore("https://example.test/samples.parquet")
    workers = 8
    ready = Barrier(workers)
    entered, release = Event(), Event()
    calls = []

    def load():
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return {"rows": 42, "categories": {"huc02": ["01"]}}

    def request():
        ready.wait(timeout=5)
        return store.config()

    monkeypatch.setattr(store, "_load_config", load)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(request) for _ in range(workers)]
        try:
            assert entered.wait(5)
        finally:
            release.set()
        results = [future.result(timeout=5) for future in futures]
    assert calls == [1]
    assert results == [{"rows": 42, "categories": {"huc02": ["01"]}}] * workers
    assert len({id(result) for result in results}) == workers


def test_config_failure_can_retry(monkeypatch) -> None:
    store = SampleStore("https://example.test/samples.parquet")
    calls = []

    def load():
        calls.append(1)
        if len(calls) == 1:
            raise OSError("temporary read failure")
        return {"rows": 42}

    monkeypatch.setattr(store, "_load_config", load)
    with pytest.raises(OSError, match="temporary read failure"):
        store.config()
    assert store.config() == {"rows": 42}
    assert store.config() == {"rows": 42}
    assert len(calls) == 2
