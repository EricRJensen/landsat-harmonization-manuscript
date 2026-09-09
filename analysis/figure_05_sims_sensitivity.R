#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(dplyr)
  library(ggdist)
  library(ggplot2)
  library(patchwork)
  library(readr)
  library(tidyr)
})
source("analysis/common/manuscript_methods.R")

input <- "data/external/annual_ET_CONUS_I_P3_oli2etm_San_Joaquin_2008_2025.csv"
output_dir <- "output"
ensure_input(input)
dir.create(file.path(output_dir, "figures"), recursive = TRUE, showWarnings = FALSE)
dir.create(file.path(output_dir, "tables"), recursive = TRUE, showWarnings = FALSE)

wide <- read_csv(input, show_col_types = FALSE)
required <- c("ACRES", paste0("v21_", 2008:2025), paste0("v21h_", 2008:2025))
missing <- setdiff(required, names(wide))
if (length(missing)) stop("SIMS input lacks columns: ", paste(missing, collapse = ", "))

long <- wide |>
  pivot_longer(matches("^v21h?_\\d{4}$"), names_to = c("version", "year"), names_pattern = "^(v21h?)_(\\d{4})$", values_to = "ET") |>
  mutate(
    year = as.integer(year),
    dataset = recode(version, v21 = "Unharmonized", v21h = "Harmonized (I-P3)")
  )

paired <- long |>
  select(-version) |>
  pivot_wider(names_from = dataset, values_from = ET) |>
  mutate(
    difference_mm = `Harmonized (I-P3)` - Unharmonized,
    # Legacy denominator retained to reproduce the draft figure. See audit.
    percent_difference = 100 * difference_mm / `Harmonized (I-P3)`
  )

intervals <- paired |>
  group_by(year) |>
  summarise(
    n = sum(is.finite(difference_mm)),
    difference_p025 = quantile(difference_mm, 0.025, na.rm = TRUE),
    difference_p25 = quantile(difference_mm, 0.25, na.rm = TRUE),
    difference_median = median(difference_mm, na.rm = TRUE),
    difference_p75 = quantile(difference_mm, 0.75, na.rm = TRUE),
    difference_p975 = quantile(difference_mm, 0.975, na.rm = TRUE),
    percent_p05 = quantile(percent_difference, 0.05, na.rm = TRUE),
    percent_p50 = median(percent_difference, na.rm = TRUE),
    percent_p95 = quantile(percent_difference, 0.95, na.rm = TRUE),
    .groups = "drop"
  )
write_csv(intervals, file.path(output_dir, "tables", "figure_05_field_intervals.csv"))

annual_means <- long |>
  group_by(year, dataset) |>
  summarise(mean_et = mean(ET, na.rm = TRUE), .groups = "drop")
panel_a <- ggplot(annual_means, aes(year, mean_et, color = dataset)) +
  geom_line() + geom_point() +
  scale_color_manual(values = c("Unharmonized" = "red", "Harmonized (I-P3)" = "black")) +
  labs(x = NULL, y = "Mean ET (mm)", color = "Dataset") +
  theme_minimal(base_size = 10) + theme(legend.position = "bottom")

panel_b <- ggplot(paired, aes(year, difference_mm)) +
  stat_lineribbon(aes(fill = after_stat(.width)), .width = c(0.5, 0.8, 0.95), color = "#08306b") +
  scale_fill_brewer(palette = "Blues", direction = -1, name = "Interval") +
  geom_hline(yintercept = 0, linetype = "dashed") +
  labs(x = NULL, y = expression(Delta * "ET (mm)")) +
  theme_minimal(base_size = 10)

panel_c <- ggplot(paired, aes(year, percent_difference)) +
  stat_lineribbon(aes(fill = after_stat(.width)), .width = c(0.5, 0.8, 0.95), color = "#08306b") +
  scale_fill_brewer(palette = "Blues", direction = -1, name = "Interval") +
  geom_hline(yintercept = 0, linetype = "dashed") +
  labs(x = "Year", y = "Percent difference (%)") +
  theme_minimal(base_size = 10)

figure <- panel_a / panel_b / panel_c + plot_layout(guides = "collect") + plot_annotation(tag_levels = "A")
ggsave(file.path(output_dir, "figures", "figure_05.png"), figure, width = 8, height = 6, dpi = 600, bg = "white")

volume <- long |>
  filter(year >= 2022, is.finite(ET), is.finite(ACRES)) |>
  mutate(volume_acre_feet = ACRES * ET * 0.00328084) |>
  group_by(year, dataset) |>
  summarise(volume_acre_feet = sum(volume_acre_feet), .groups = "drop") |>
  pivot_wider(names_from = dataset, values_from = volume_acre_feet) |>
  mutate(difference_acre_feet = `Harmonized (I-P3)` - Unharmonized)
write_csv(volume, file.path(output_dir, "tables", "figure_05_volume_summary.csv"))
