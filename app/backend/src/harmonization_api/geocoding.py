from __future__ import annotations

from typing import Any

import httpx


PHOTON_URL = "https://photon.komoot.io/api"
CONUS_BBOX = (-125.0, 24.0, -66.0, 50.0)


def _label(properties: dict[str, Any]) -> str:
    parts: list[str] = []
    street = " ".join(
        str(value).strip()
        for value in (properties.get("housenumber"), properties.get("street"))
        if value
    )
    for value in (
        properties.get("name"),
        street,
        properties.get("city") or properties.get("district") or properties.get("county"),
        properties.get("state"),
    ):
        text = str(value).strip() if value else ""
        if text and text.casefold() not in {part.casefold() for part in parts}:
            parts.append(text)
    return ", ".join(parts)


def format_photon_results(payload: dict[str, Any]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    west, south, east, north = CONUS_BBOX
    for feature in payload.get("features", []):
        coordinates = feature.get("geometry", {}).get("coordinates", [])
        if len(coordinates) < 2:
            continue
        longitude, latitude = float(coordinates[0]), float(coordinates[1])
        if not (west <= longitude <= east and south <= latitude <= north):
            continue
        properties = feature.get("properties", {})
        if str(properties.get("countrycode", "")).casefold() != "us":
            continue
        label = _label(properties)
        if not label:
            continue
        result_id = f"{properties.get('osm_type', 'place')}-{properties.get('osm_id', len(results))}"
        if result_id in seen:
            continue
        seen.add(result_id)
        results.append({
            "id": result_id,
            "label": label,
            "type": properties.get("type") or properties.get("osm_value") or "place",
            "longitude": longitude,
            "latitude": latitude,
        })
    return results


async def search_photon(query: str) -> list[dict[str, Any]]:
    params = {
        "q": query,
        "limit": 6,
        "lang": "en",
        "bbox": ",".join(str(value) for value in CONUS_BBOX),
    }
    headers = {"User-Agent": "Landsat-Harmonization-Explorer/0.1 (research location search)"}
    async with httpx.AsyncClient(timeout=8.0, headers=headers) as client:
        response = await client.get(PHOTON_URL, params=params)
        response.raise_for_status()
    return format_photon_results(response.json())
