#!/usr/bin/env python3
"""Export annual operational and harmonized SIMS ET for San Joaquin fields.

The harmonized collection is restricted and is not constructed by this
repository. Use ``--validate-only`` for a local, non-submitting check. The
``--start-task`` flag is required to submit the Drive export.
"""

from __future__ import annotations

import argparse

OPERATIONAL = "projects/openet/assets/sims/conus/gridmet/monthly/v2_1"
HARMONIZED = "projects/openet/sims/conus/gridmet/monthly/v2_1_harmonized_oli2etm"
FIELDS = "projects/openet/assets/features/geodatabase_v2/CA"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="Earth Engine quota project")
    parser.add_argument("--drive-folder", required=True)
    parser.add_argument("--state-fips", default="06")
    parser.add_argument("--county", default="San Joaquin")
    parser.add_argument("--start-year", type=int, default=2008)
    parser.add_argument("--end-year", type=int, default=2025)
    parser.add_argument("--scale", type=int, default=30)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--start-task", action="store_true")
    return parser.parse_args()


def validate(args: argparse.Namespace) -> None:
    if args.start_year > args.end_year:
        raise ValueError("start-year must not exceed end-year")
    if args.scale <= 0:
        raise ValueError("scale must be positive")
    if not args.project.strip() or not args.drive_folder.strip():
        raise ValueError("project and drive-folder must be non-empty")
    print(f"county={args.county}, state_fips={args.state_fips}")
    print(f"years={args.start_year}-{args.end_year}, scale={args.scale} m")
    print(f"operational_collection={OPERATIONAL}")
    print(f"harmonized_collection={HARMONIZED} (restricted)")
    print("No task is submitted unless --start-task is supplied.")


def build_task(args: argparse.Namespace):
    import ee

    ee.Initialize(project=args.project)
    years = list(range(args.start_year, args.end_year + 1))
    start = f"{args.start_year}-01-01"
    end = f"{args.end_year + 1}-01-01"
    counties = ee.FeatureCollection("TIGER/2018/Counties")
    county = counties.filter(ee.Filter.eq("STATEFP", args.state_fips)).filter(
        ee.Filter.eq("NAME", args.county)
    )
    geometry = county.geometry()
    fields = ee.FeatureCollection(FIELDS).filterBounds(geometry)
    operational = ee.ImageCollection(OPERATIONAL).filterDate(start, end).filterBounds(geometry)
    harmonized = ee.ImageCollection(HARMONIZED).filterDate(start, end).filterBounds(geometry)

    def annual_stack(collection, prefix):
        images = []
        for year in years:
            year_start = ee.Date.fromYMD(year, 1, 1)
            images.append(
                collection.filterDate(year_start, year_start.advance(1, "year"))
                .select("et")
                .sum()
                .rename(f"{prefix}_{year}")
            )
        return ee.Image.cat(images)

    stack = annual_stack(operational, "v21").addBands(annual_stack(harmonized, "v21h"))
    results = stack.reduceRegions(
        collection=fields,
        reducer=ee.Reducer.mean(),
        scale=args.scale,
        tileScale=4,
    )
    columns = ["OPENET_ID", "Unique_ID", "ACRES"] + [
        f"{prefix}_{year}" for prefix in ("v21", "v21h") for year in years
    ]
    results = results.select(propertySelectors=columns, retainGeometry=False)
    description = (
        f"annual_ET_CONUS_I_P3_oli2etm_{args.county.replace(' ', '_')}_"
        f"{args.start_year}_{args.end_year}"
    )
    return ee.batch.Export.table.toDrive(
        collection=results,
        description=description,
        folder=args.drive_folder,
        fileFormat="CSV",
        selectors=columns,
    )


def main() -> None:
    args = parse_args()
    validate(args)
    if args.validate_only:
        return
    task = build_task(args)
    if args.start_task:
        task.start()
        print(f"started {task.id}")
    else:
        print("task built but not submitted")


if __name__ == "__main__":
    main()

