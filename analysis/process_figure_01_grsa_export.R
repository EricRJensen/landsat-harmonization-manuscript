#!/usr/bin/env Rscript
suppressPackageStartupMessages({
  library(dplyr)
  library(readr)
  library(tidyr)
})
source("analysis/common/manuscript_methods.R")

input <- "data/external/Landsat_SR_NDVI_1984_2025_Great_Sand_Dunes_casestudy_v1.csv"
output <- "data/external/grsa_ndvi_ts.csv"
ensure_input(input)

series <- read_csv(input, show_col_types = FALSE) |>
  transmute(
    year = as.integer(year),
    output_col = case_when(
      product == "LANDSAT_SR" & harmonization == "none" ~ "unharmonized",
      product == "LANDSAT_SR" & harmonization == "l7_to_l8" ~ "harmonized",
      product == "LANDSAT5_SR" & harmonization == "none" ~ "LS5",
      product == "LANDSAT7_SR" & harmonization == "none" ~ "LS7",
      product == "LANDSAT8_SR" & harmonization == "none" ~ "LS8",
      product == "LANDSAT9_SR" & harmonization == "none" ~ "LS9",
      TRUE ~ NA_character_
    ),
    value = as.numeric(value)
  ) |>
  filter(!is.na(output_col)) |>
  pivot_wider(id_cols = year, names_from = output_col, values_from = value) |>
  arrange(year) |>
  select(year, LS5, LS7, LS8, LS9, unharmonized, harmonized)

dir.create(dirname(output), recursive = TRUE, showWarnings = FALSE)
write_csv(series, output)
