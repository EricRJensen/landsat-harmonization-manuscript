#!/usr/bin/env python3
"""
We ran two 2.5 million point samplings using the LEOHS pipeline, which were merged into a nominal 5 million point sample.
"""

from __future__ import annotations

import argparse
import importlib.metadata
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aoi", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--sample-points", type=int, default=2_500_000)
    parser.add_argument("--max-cloud-cover", type=int, default=30)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument(
        "--run",
        action="store_true",
        help="Execute sampling; omitted by default because it creates cloud/local outputs",
    )
    return parser.parse_args()


def validate(args: argparse.Namespace) -> None:
    if not args.aoi.is_file():
        raise FileNotFoundError(f"AOI does not exist: {args.aoi}")
    if args.sample_points <= 0:
        raise ValueError("sample-points must be positive")
    if not args.project.strip():
        raise ValueError("project must be non-empty")
    try:
        version = importlib.metadata.version("leohs")
    except importlib.metadata.PackageNotFoundError as error:
        raise RuntimeError("LEOHS is not installed; the recorded run used 1.1.2") from error
    print(f"leohs_version={version} (recorded run logs: 1.1.2; manuscript: 1.2.0)")
    print(f"aoi={args.aoi.resolve()}")
    print(f"output={args.output.resolve()}")
    print("months=4-10; years=2013-2021; Deep=True; SR; maxCloudCover=30")
    print("No sampling occurs unless --run is supplied.")


def main() -> None:
    args = parse_args()
    validate(args)
    if args.validate_only or not args.run:
        return
    import ee
    import leohs

    args.output.mkdir(parents=True, exist_ok=True)
    ee.Initialize(project=args.project)
    leohs.run_leohs(
        Aoi_shp_path=str(args.aoi),
        Save_folder_path=str(args.output),
        SR_or_TOA="SR",
        months=list(range(4, 11)),
        years=list(range(2013, 2021)),
        sample_points_n=args.sample_points,
        maxCloudCover=args.max_cloud_cover,
        Deep=True,
        project_ID=args.project,
    )


if __name__ == "__main__":
    main()

