from harmonization_api.ee_pipeline import HARMONIZED_SENSORS, SENSOR_END_EXCLUSIVE


def test_manuscript_sensor_cutoffs_exclude_post_mission_years() -> None:
    assert SENSOR_END_EXCLUSIVE["L5"] == "2012-01-01"
    assert SENSOR_END_EXCLUSIVE["L7"] == "2022-01-01"


def test_reference_sensors_do_not_have_early_cutoffs() -> None:
    assert "L8" not in SENSOR_END_EXCLUSIVE
    assert "L9" not in SENSOR_END_EXCLUSIVE


def test_harmonization_direction_selects_the_source_sensor_family() -> None:
    assert HARMONIZED_SENSORS["L7_to_L8"] == ("L5", "L7")
    assert HARMONIZED_SENSORS["L8_to_L7"] == ("L8", "L9")
