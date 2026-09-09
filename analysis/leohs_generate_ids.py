#!/usr/bin/env python3
"""Add deterministic leohs_id values to one CSV file or a directory of CSVs.

IDs are SHA-256 hashes of the two Landsat image IDs and canonicalized point
coordinates. Processing is streaming, and a temporary SQLite database verifies
global uniqueness without retaining all IDs in memory.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Sequence

from leohs_extract_covariates import canonical_location, parse_wkt_point


ID_COLUMN = "leohs_id"
ID_DIGEST_CHARS = 24
REQUIRED_COLUMNS = ("L7_image_id", "L8_image_id", "geometry")


class IdGenerationError(RuntimeError):
    """A user-facing input or ID validation error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def leohs_id(
    l7_image_id: str,
    l8_image_id: str,
    canonical_longitude: str,
    canonical_latitude: str,
    digest_chars: int = ID_DIGEST_CHARS,
) -> tuple[str, str]:
    """Return the deterministic ID and its canonical identity payload."""
    payload = "|".join(
        (
            l7_image_id.strip(),
            l8_image_id.strip(),
            canonical_longitude,
            canonical_latitude,
        )
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:digest_chars], payload


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def discover_inputs(input_path: Path, pattern: str, recursive: bool) -> list[Path]:
    if input_path.is_file():
        return [input_path]
    if not input_path.is_dir():
        raise IdGenerationError(f"Input does not exist: {input_path}")
    iterator: Iterator[Path] = (
        input_path.rglob(pattern) if recursive else input_path.glob(pattern)
    )
    files = sorted(path for path in iterator if path.is_file())
    if not files:
        raise IdGenerationError(f"No files matching {pattern!r} found in {input_path}")
    return files


def output_path_for(
    input_file: Path,
    input_root: Path,
    output_dir: Path | None,
    in_place: bool,
) -> Path:
    if in_place:
        return input_file
    if output_dir is not None:
        relative = (
            input_file.name
            if input_root.is_file()
            else input_file.relative_to(input_root)
        )
        return output_dir / relative
    return input_file.with_name(f"{input_file.stem}_with_ids{input_file.suffix}")


def create_registry(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE sample_ids (
            leohs_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL UNIQUE,
            source_file TEXT NOT NULL,
            source_row INTEGER NOT NULL
        )
        """
    )
    return connection


def register_id(
    connection: sqlite3.Connection,
    sample_id: str,
    payload: str,
    source_file: Path,
    source_row: int,
) -> None:
    try:
        connection.execute(
            """
            INSERT INTO sample_ids(leohs_id, payload, source_file, source_row)
            VALUES (?, ?, ?, ?)
            """,
            (sample_id, payload, str(source_file), source_row),
        )
    except sqlite3.IntegrityError as exc:
        existing = connection.execute(
            """
            SELECT leohs_id, payload, source_file, source_row
            FROM sample_ids WHERE leohs_id = ? OR payload = ?
            """,
            (sample_id, payload),
        ).fetchone()
        if existing and existing[1] == payload:
            raise IdGenerationError(
                "Duplicate LEOHS sample identity at "
                f"{source_file}:{source_row}; first seen at {existing[2]}:{existing[3]}"
            ) from exc
        raise IdGenerationError(
            f"Truncated SHA-256 collision for {sample_id} at {source_file}:{source_row}"
        ) from exc


def generate_file(
    input_file: Path,
    output_file: Path,
    registry: sqlite3.Connection,
    force: bool,
) -> dict[str, object]:
    if output_file.exists() and output_file != input_file and not force:
        raise IdGenerationError(f"Output already exists: {output_file}. Use --force.")
    output_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_file.with_name(f".{output_file.name}.tmp")
    temporary.unlink(missing_ok=True)
    input_sha256 = sha256_file(input_file)
    row_count = 0
    try:
        with input_file.open("r", newline="", encoding="utf-8") as source, temporary.open(
            "w", newline="", encoding="utf-8"
        ) as destination:
            reader = csv.DictReader(source)
            fieldnames = list(reader.fieldnames or [])
            missing = [column for column in REQUIRED_COLUMNS if column not in fieldnames]
            if missing:
                raise IdGenerationError(f"{input_file} is missing columns: {missing}")
            if ID_COLUMN in fieldnames:
                raise IdGenerationError(f"{input_file} already contains {ID_COLUMN!r}")
            writer = csv.DictWriter(
                destination,
                fieldnames=[ID_COLUMN] + fieldnames,
                lineterminator="\n",
            )
            writer.writeheader()
            for source_row, row in enumerate(reader):
                empty_ids = [
                    column
                    for column in ("L7_image_id", "L8_image_id")
                    if not row[column].strip()
                ]
                if empty_ids:
                    raise IdGenerationError(
                        f"Empty image ID column(s) at {input_file}:{source_row}: "
                        f"{empty_ids}"
                    )
                try:
                    longitude, latitude = parse_wkt_point(row["geometry"])
                except Exception as exc:
                    raise IdGenerationError(
                        f"Invalid geometry at {input_file}:{source_row}: {exc}"
                    ) from exc
                canonical_lon, canonical_lat = canonical_location(longitude, latitude)
                sample_id, payload = leohs_id(
                    row["L7_image_id"], row["L8_image_id"], canonical_lon, canonical_lat
                )
                register_id(registry, sample_id, payload, input_file, source_row)
                writer.writerow({ID_COLUMN: sample_id, **row})
                row_count += 1
                if row_count % 50_000 == 0:
                    registry.commit()
        registry.commit()
        os.replace(temporary, output_file)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return {
        "input": str(input_file),
        "input_sha256": input_sha256,
        "output": str(output_file),
        "output_sha256": sha256_file(output_file),
        "row_count": row_count,
    }


def default_output_dir(input_path: Path) -> Path | None:
    if input_path.is_dir():
        return input_path.with_name(f"{input_path.name}_with_ids")
    return None


def run(args: argparse.Namespace) -> None:
    input_path = Path(args.input).resolve()
    input_files = discover_inputs(input_path, args.pattern, args.recursive)
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else default_output_dir(input_path)
    )
    if args.in_place and args.output_dir:
        raise IdGenerationError("--in-place and --output-dir cannot be used together.")

    with tempfile.TemporaryDirectory(prefix="leohs_ids_") as temporary_dir:
        registry = create_registry(Path(temporary_dir) / "ids.sqlite")
        file_results = []
        try:
            for input_file in input_files:
                output_file = output_path_for(
                    input_file, input_path, output_dir, args.in_place
                )
                result = generate_file(input_file, output_file, registry, args.force)
                file_results.append(result)
                print(f"Generated {result['row_count']:,} IDs: {output_file}")
        finally:
            registry.close()

    manifest = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "id_column": ID_COLUMN,
        "id_definition": (
            "first 24 hexadecimal characters of SHA-256("
            "L7_image_id|L8_image_id|longitude_12dp|latitude_12dp)"
        ),
        "files": file_results,
        "total_rows": sum(int(item["row_count"]) for item in file_results),
    }
    if output_dir is not None:
        manifest_path = output_dir / "leohs_id_manifest.json"
    elif input_path.is_dir():
        manifest_path = input_path / "leohs_id_manifest.json"
    else:
        manifest_path = Path(file_results[0]["output"]).with_suffix(
            ".leohs_id_manifest.json"
        )
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"Wrote manifest: {manifest_path}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Input CSV file or directory")
    parser.add_argument("--output-dir", help="Output directory preserving input filenames")
    parser.add_argument("--pattern", default="*.csv", help="Directory file glob")
    parser.add_argument("--recursive", action="store_true")
    parser.add_argument(
        "--in-place", action="store_true", help="Atomically replace input files"
    )
    parser.add_argument("--force", action="store_true", help="Replace existing output files")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        run(args)
    except IdGenerationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
