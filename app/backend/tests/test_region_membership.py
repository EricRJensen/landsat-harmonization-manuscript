from harmonization_api.region_membership import RegionBoundaryStore
from harmonization_api.settings import get_settings


def test_upper_colorado_membership_distinguishes_inside_and_outside_locations() -> None:
    store = RegionBoundaryStore(get_settings().region_boundary_dir)

    assert store.contains("huc02", "14", -108.5506, 39.0639) is True  # Grand Junction
    assert store.contains("huc02", "14", -104.9849, 39.7392) is False  # Denver
    assert store.contains("conus", "CONUS", -104.9849, 39.7392) is True
