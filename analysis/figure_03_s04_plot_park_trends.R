#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(patchwork)
  library(readr)
  library(sf)
  library(terra)
  library(tidyr)
  library(tidyterra)
})
source("analysis/common/manuscript_methods.R")

input_dir <- "data/external/park_trends"
boundary_path <- "data/external/nps_boundaries.shp"
output_dir <- "output"
ensure_input(input_dir)
ensure_input(boundary_path)
dir.create(file.path(output_dir, "figures"), recursive = TRUE, showWarnings = FALSE)
dir.create(file.path(output_dir, "tables"), recursive = TRUE, showWarnings = FALSE)

parks <- tibble::tribble(
  ~code, ~label, ~directory,
  "YELL", "Yellowstone", "YELL_CONUS_Poly3_Direct",
  "GRSA", "Great Sand Dunes", "GRSA_CONUS_Poly3_Direct"
)
strict_p <- 0.01
loose_p <- 0.05
masked_nlcd <- c(11, 23, 24, 31)

find_raster <- function(directory, stem) {
  matches <- list.files(directory, pattern = paste0("^", stem, ".*\\.tif$"), full.names = TRUE)
  if (length(matches) != 1L) stop("Expected one ", stem, " GeoTIFF in ", directory)
  rast(matches[[1]])
}

classify <- function(slope, p_value) {
  case_when(
    p_value < strict_p & slope < 0 ~ "p < 0.01 decrease",
    p_value < loose_p & slope < 0 ~ "p < 0.05 decrease",
    p_value < strict_p & slope >= 0 ~ "p < 0.01 increase",
    p_value < loose_p & slope >= 0 ~ "p < 0.05 increase",
    TRUE ~ "Not significant"
  )
}

load_park <- function(code, label, directory) {
  path <- file.path(input_dir, directory)
  raw <- find_raster(path, "landsat_2000_2022_raw")
  harm <- find_raster(path, "landsat_2000_2022_harm")
  modis <- find_raster(path, "modis_2000_2022")
  required_landsat <- c("NDVI_slope", "NDVI_mean", "NDVI_pval", "nlcd_mode")
  required_modis <- c("NDVI_slope", "NDVI_mean", "NDVI_pval")
  if (!all(required_landsat %in% names(raw)) || !all(required_landsat %in% names(harm))) {
    stop("Landsat GeoTIFFs for ", code, " lack required bands")
  }
  if (!all(required_modis %in% names(modis))) stop("MODIS GeoTIFF for ", code, " lacks required bands")

  natural <- !raw$nlcd_mode %in% masked_nlcd
  raw <- mask(raw, natural, maskvalues = 0)
  harm <- mask(harm, natural, maskvalues = 0)
  invalid_fraction <- project(ifel(natural, 0, 1), modis$NDVI_slope, method = "average")
  modis <- mask(modis, invalid_fraction < 0.5, maskvalues = 0)

  to_frame <- function(raster, image) {
    as.data.frame(raster[[required_modis]], xy = TRUE, na.rm = TRUE) |>
      transmute(
        park = label,
        image = image,
        x, y,
        slope = NDVI_slope * 10,
        mean_ndvi = NDVI_mean,
        p_value = NDVI_pval,
        trend_class = classify(slope, p_value)
      )
  }
  bind_rows(
    to_frame(raw, "Unharmonized Landsat"),
    to_frame(harm, "Harmonized Landsat"),
    to_frame(modis, "MODIS")
  )
}

trend_data <- purrr::pmap_dfr(parks, load_park)
nps <- st_read(boundary_path, quiet = TRUE)
code_candidates <- names(nps)[tolower(names(nps)) %in% c("unit_code", "unitcode", "unit_code_1")]
if (!length(code_candidates)) stop("NPS boundary file has no recognizable unit-code field")
code_field <- code_candidates[[1]]
target_crs <- crs(find_raster(file.path(input_dir, parks$directory[[1]]), "landsat_2000_2022_raw"), proj = TRUE)
nps <- nps |>
  filter(.data[[code_field]] %in% parks$code) |>
  mutate(park = parks$label[match(.data[[code_field]], parks$code)]) |>
  st_make_valid() |>
  st_transform(target_crs)
boundary_facets <- bind_rows(lapply(
  c("Unharmonized Landsat", "Harmonized Landsat", "MODIS"),
  function(value) mutate(nps, image = value)
))
summary <- trend_data |>
  group_by(park, image) |>
  summarise(
    n_pixels = n(),
    mean_slope = mean(slope),
    sd_slope = sd(slope),
    pct_sig_increase = 100 * mean(p_value < loose_p & slope > 0),
    pct_sig_decrease = 100 * mean(p_value < loose_p & slope < 0),
    pct_nonsig = 100 * mean(p_value >= loose_p),
    pct_net_significant = pct_sig_increase - pct_sig_decrease,
    .groups = "drop"
  )
write_csv(summary, file.path(output_dir, "tables", "figure_03_trend_summary.csv"))

map_plot <- ggplot(trend_data, aes(x, y, fill = slope)) +
  geom_raster() +
  geom_sf(data = boundary_facets, inherit.aes = FALSE, fill = NA, color = "black", linewidth = 0.25) +
  facet_grid(park ~ image, scales = "free") +
  coord_sf() +
  scale_fill_gradient2(low = "#b2182b", mid = "white", high = "#2166ac", midpoint = 0, limits = c(-0.05, 0.05), oob = scales::squish) +
  labs(x = NULL, y = NULL, fill = "NDVI trend / decade") +
  theme_void(base_size = 10) +
  theme(legend.position = "bottom", strip.text = element_text())

proportions <- trend_data |>
  count(park, image, trend_class) |>
  group_by(park, image) |>
  mutate(percent = 100 * n / sum(n)) |>
  ungroup()
bar_plot <- ggplot(proportions, aes(image, percent, fill = trend_class)) +
  geom_col() +
  facet_wrap(~park, ncol = 1) +
  coord_flip() +
  labs(x = NULL, y = "Pixels (%)", fill = NULL) +
  theme_minimal(base_size = 9) +
  theme(legend.position = "bottom")

figure_03 <- map_plot / bar_plot + plot_layout(heights = c(3, 1.2)) + plot_annotation(tag_levels = "A")
ggsave(file.path(output_dir, "figures", "figure_03.png"), figure_03, width = 13.5, height = 7.5, dpi = 400, bg = "white")

binned <- trend_data |>
  mutate(ndvi_bin = cut(mean_ndvi, breaks = seq(0, 1, 0.1), include.lowest = TRUE)) |>
  filter(!is.na(ndvi_bin)) |>
  group_by(park, image, ndvi_bin) |>
  summarise(
    n = n(),
    pct_significant = 100 * mean(p_value < loose_p),
    .groups = "drop"
  )
write_csv(binned, file.path(output_dir, "tables", "figure_s04_ndvi_bins.csv"))

density_plot <- ggplot(trend_data, aes(mean_ndvi, color = image, fill = image)) +
  geom_density(alpha = 0.12) +
  facet_wrap(~park, ncol = 1, scales = "free_y") +
  coord_cartesian(xlim = c(0, 1)) +
  labs(x = "Mean JJA NDVI", y = "Density", color = NULL, fill = NULL) +
  theme_minimal(base_size = 10) +
  theme(legend.position = "bottom")
significance_plot <- ggplot(binned, aes(ndvi_bin, pct_significant, color = image, group = image)) +
  geom_line() + geom_point() +
  facet_wrap(~park, ncol = 1) +
  labs(x = "Mean JJA NDVI bin", y = "Significant pixels (%)", color = NULL) +
  theme_minimal(base_size = 10) +
  theme(axis.text.x = element_text(angle = 45, hjust = 1), legend.position = "bottom")
figure_s04 <- density_plot / significance_plot + plot_annotation(tag_levels = "A")
ggsave(file.path(output_dir, "figures", "figure_s04.png"), figure_s04, width = 7, height = 9, dpi = 400, bg = "white")
