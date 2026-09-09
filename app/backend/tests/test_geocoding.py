from harmonization_api.geocoding import format_photon_results


def test_photon_results_are_labeled_and_limited_to_conus() -> None:
    payload = {"features": [
        {
            "geometry": {"coordinates": [-104.9903, 39.7392]},
            "properties": {"osm_type": "N", "osm_id": 1, "name": "Denver", "state": "Colorado", "type": "city", "countrycode": "US"},
        },
        {
            "geometry": {"coordinates": [-123.1207, 49.2827]},
            "properties": {"osm_type": "N", "osm_id": 2, "name": "Vancouver", "state": "British Columbia", "countrycode": "CA"},
        },
        {
            "geometry": {"coordinates": [-104.9903, 39.7392]},
            "properties": {"osm_type": "N", "osm_id": 1, "name": "Denver duplicate", "state": "Colorado", "countrycode": "US"},
        },
    ]}

    assert format_photon_results(payload) == [{
        "id": "N-1",
        "label": "Denver, Colorado",
        "type": "city",
        "longitude": -104.9903,
        "latitude": 39.7392,
    }]
