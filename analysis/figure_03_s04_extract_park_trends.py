#!/usr/bin/env python3
"""Build the Figure 3/S4 park trend exports in Google Earth Engine.

Configuration validation is local and never submits tasks. Export submission
requires the explicit ``--start-tasks`` flag.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass

NDVI_POLY3_L7_TO_L8 = (0.0055, 1.2289, -0.3197, 0.0575)
SITE_ASSETS = {
    "YELL": "projects/dri-blm/assets/ls-harm/trend_aoi_YELL",
    "GRSA": "projects/dri-blm/assets/ls-harm/trend_aoi_GRSA",
}
LANDSAT_COLLECTIONS = {
    "L5": ("LANDSAT/LT05/C02/T1_L2", ("SR_B3", "SR_B4")),
    "L7": ("LANDSAT/LE07/C02/T1_L2", ("SR_B3", "SR_B4")),
    "L8": ("LANDSAT/LC08/C02/T1_L2", ("SR_B4", "SR_B5")),
    "L9": ("LANDSAT/LC09/C02/T1_L2", ("SR_B4", "SR_B5")),
}


@dataclass(frozen=True)
class ExportConfig:
    site: str
    project: str
    drive_folder: str
    start_year: int = 2000
    end_year: int = 2022
    minimum_years: int = 8
    crs: str = "EPSG:5070"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True, choices=sorted(SITE_ASSETS))
    parser.add_argument("--project", required=True, help="Earth Engine quota project")
    parser.add_argument("--drive-folder", required=True)
    parser.add_argument("--start-year", type=int, default=2000)
    parser.add_argument("--end-year", type=int, default=2022)
    parser.add_argument("--minimum-years", type=int, default=8)
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate and print configuration without contacting Earth Engine",
    )
    parser.add_argument(
        "--start-tasks",
        action="store_true",
        help="Submit three Drive exports; omitted by default for safety",
    )
    return parser.parse_args()


def validate(config: ExportConfig) -> None:
    if config.start_year >= config.end_year:
        raise ValueError("start-year must be earlier than end-year")
    if config.minimum_years < 2:
        raise ValueError("minimum-years must be at least 2")
    if not config.project.strip() or not config.drive_folder.strip():
        raise ValueError("project and drive-folder must be non-empty")
    print(f"site={config.site}")
    print(f"aoi={SITE_ASSETS[config.site]}")
    print(f"years={config.start_year}-{config.end_year}; L7 capped at 2021")
    print(f"drive_folder={config.drive_folder}")
    print("outputs=landsat_2000_2022_raw, landsat_2000_2022_harm, modis_2000_2022")
    print("No task is submitted unless --start-tasks is supplied.")


def build_exports(config: ExportConfig, start_tasks: bool):
    import ee

    ee.Initialize(project=config.project)
    aoi = ee.FeatureCollection(SITE_ASSETS[config.site]).geometry()

    def mask_landsat(image):
        # This is the mask present in the archived script. The exact external
        # Climate Engine mask implementation was not stored with the project.
        qa = image.select("QA_PIXEL")
        rejected = sum(1 << bit for bit in (1, 2, 3, 4, 5))
        return image.updateMask(qa.bitwiseAnd(rejected).eq(0)).updateMask(
            image.select("QA_RADSAT").eq(0)
        )

    def polynomial(image):
        result = ee.Image.constant(NDVI_POLY3_L7_TO_L8[0]).updateMask(image.mask())
        for power, coefficient in enumerate(NDVI_POLY3_L7_TO_L8[1:], start=1):
            result = result.add(image.pow(power).multiply(coefficient))
        return result.rename("NDVI")

    def landsat_collection(harmonized: bool):
        merged = ee.ImageCollection([])
        for sensor, (collection_id, source_bands) in LANDSAT_COLLECTIONS.items():
            sensor_end = min(config.end_year, 2021) if sensor == "L7" else config.end_year
            collection = (
                ee.ImageCollection(collection_id)
                .filterBounds(aoi)
                .filterDate(f"{config.start_year}-01-01", f"{sensor_end + 1}-01-01")
                .filter(ee.Filter.calendarRange(6, 8, "month"))
            )

            def prepare(image, sensor_name=sensor, bands=source_bands):
                reflectance = (
                    mask_landsat(image)
                    .select(list(bands), ["red", "nir"])
                    .multiply(0.0000275)
                    .add(-0.2)
                )
                ndvi = reflectance.normalizedDifference(["nir", "red"]).rename("NDVI")
                if harmonized and sensor_name in ("L5", "L7"):
                    ndvi = polynomial(ndvi)
                return ndvi.toFloat().copyProperties(image, ["system:time_start"])

            merged = merged.merge(collection.map(prepare))
        return merged

    def modis_collection():
        collection = (
            ee.ImageCollection("MODIS/061/MOD13Q1")
            .filterBounds(aoi)
            .filterDate(f"{config.start_year}-01-01", f"{config.end_year + 1}-01-01")
            .filter(ee.Filter.calendarRange(6, 8, "month"))
        )

        def prepare(image):
            return (
                image.select("NDVI")
                .multiply(0.0001)
                .rename("NDVI")
                .updateMask(image.select("SummaryQA").lte(1))
                .toFloat()
                .copyProperties(image, ["system:time_start"])
            )

        return collection.map(prepare)

    def annual_medians(collection):
        years = ee.List.sequence(config.start_year, config.end_year)

        def one_year(year):
            year = ee.Number(year)
            subset = collection.filter(ee.Filter.calendarRange(year, year, "year"))
            return (
                subset.median()
                .rename("NDVI")
                .addBands(ee.Image.constant(year).float().rename("year"))
                .set("n_scenes", subset.size())
            )

        return ee.ImageCollection(years.map(one_year)).filter(ee.Filter.gt("n_scenes", 0))

    def trend_image(collection):
        annual = annual_medians(collection)
        time_series = annual.map(lambda image: image.select(["year", "NDVI"]).toFloat())
        slope = time_series.reduce(ee.Reducer.sensSlope()).select("slope").rename("NDVI_slope")
        mean = annual.select("NDVI").mean().rename("NDVI_mean")
        tau = time_series.reduce(ee.Reducer.kendallsCorrelation(2)).select(0).rename("NDVI_tau")
        count = annual.select("NDVI").count().toFloat().rename("NDVI_n")
        variance = count.multiply(2).add(5).multiply(2).divide(
            count.multiply(count.subtract(1)).multiply(9)
        )
        p_value = tau.divide(variance.sqrt()).abs().divide(math.sqrt(2)).erfc().rename("NDVI_pval")
        return slope.addBands([mean, tau, p_value, count]).updateMask(count.gte(config.minimum_years))

    nlcd = (
        ee.ImageCollection("projects/sat-io/open-datasets/USGS/ANNUAL_NLCD/LANDCOVER")
        .filterBounds(aoi)
        .filterDate("2015-01-01", "2025-01-01")
        .map(lambda image: image.select(0).rename("landcover"))
        .reduce(ee.Reducer.mode())
        .rename("nlcd_mode")
    )
    products = {
        "landsat_2000_2022_raw": (trend_image(landsat_collection(False)).addBands(nlcd), 30),
        "landsat_2000_2022_harm": (trend_image(landsat_collection(True)).addBands(nlcd), 30),
        "modis_2000_2022": (trend_image(modis_collection()), 250),
    }
    tasks = {}
    for name, (image, scale) in products.items():
        task = ee.batch.Export.image.toDrive(
            image=image.toFloat().clip(aoi),
            description=name,
            folder=config.drive_folder,
            fileNamePrefix=name,
            region=aoi,
            scale=scale,
            crs=config.crs,
            maxPixels=1e13,
        )
        tasks[name] = task
        if start_tasks:
            task.start()
            print(f"started {name}: {task.id}")
        else:
            print(f"built {name}; task not submitted")
    return tasks


def main() -> None:
    args = parse_args()
    config = ExportConfig(
        site=args.site,
        project=args.project,
        drive_folder=args.drive_folder,
        start_year=args.start_year,
        end_year=args.end_year,
        minimum_years=args.minimum_years,
    )
    validate(config)
    if not args.validate_only:
        build_exports(config, start_tasks=args.start_tasks)


if __name__ == "__main__":
    main()

