from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

import duckdb

from .sample_store import derived_cte
from .settings import get_settings


def required_executable(name: str) -> str:
    executable = shutil.which(name)
    if not executable:
        raise RuntimeError(
            f"{name} is required to build PMTiles. Install tippecanoe and the pmtiles CLI first."
        )
    return executable


def build_sample_tiles(source: str, output: Path, work_dir: Path | None = None) -> None:
    tippecanoe = required_executable("tippecanoe")
    pmtiles = required_executable("pmtiles")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=work_dir) as temporary:
        temporary_path = Path(temporary)
        csv_path = temporary_path / "landsat_samples.csv"
        mbtiles_path = temporary_path / "landsat_samples.mbtiles"
        connection = duckdb.connect()
        try:
            connection.execute("SET threads=4")
            escaped_csv = str(csv_path).replace("'", "''")
            connection.execute(
                derived_cte(source)
                + f"""
                COPY (
                    SELECT longitude, latitude, leohs_id, image_year, image_month,
                           l7_date, l8_date, L7_image_id, L8_image_id,
                           l7_ndvi, l8_ndvi, ndvi_offset,
                           l7_evi, l8_evi, evi_offset,
                           l7_msavi, l8_msavi, msavi_offset,
                           b_offset, g_offset, r_offset, nir_offset, swir1_offset, swir2_offset,
                           ecoregion_l2_id, ecoregion_l3_id, huc02_id, nlcd_landcover
                    FROM samples
                    WHERE longitude IS NOT NULL AND latitude IS NOT NULL
                ) TO '{escaped_csv}' (HEADER, DELIMITER ',')
                """
            )
        finally:
            connection.close()
        subprocess.run(
            [
                tippecanoe,
                "--force",
                "--layer=landsat_samples",
                "--minimum-zoom=3",
                "--maximum-zoom=14",
                "--drop-densest-as-needed",
                "--extend-zooms-if-still-dropping",
                "--read-parallel",
                f"--output={mbtiles_path}",
                str(csv_path),
            ],
            check=True,
        )
        subprocess.run([pmtiles, "convert", str(mbtiles_path), str(output)], check=True)
    print(f"Wrote {output}")


def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser(description="Build deployable PMTiles for paired parquet samples")
    parser.add_argument("--source", default=settings.sample_parquet)
    parser.add_argument("--output", type=Path, default=Path("artifacts/landsat_samples.pmtiles"))
    parser.add_argument("--work-dir", type=Path)
    args = parser.parse_args()
    build_sample_tiles(args.source, args.output, args.work_dir)


if __name__ == "__main__":
    main()

