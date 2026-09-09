# Reproducibility notes

These notes identify differences between the manuscript description, the
available source code, and the archived paired-sample dataset. They should be
resolved where possible before publication.

## Paired sample

- The archived parquet contains 4,820,405 observations. The original notebook
  records one 2,500,000-point LEOHS run, while the release appears to combine
  two runs. The random seeds and exact merge command were not retained.
- Available logs identify LEOHS 1.1.2, the manuscript states 1.2.0, and the old
  source tree contained version 1.1.1.
- The parquet contains 2,071 Landsat 8 observations from April 7, 2013. These
  precede the April 10 operational start stated in the manuscript.
- The dataset contains several historical analysis populations rather than one
  common training filter: 3,286,393 coefficient-fitting rows, 3,285,686 rows
  with complete ancillary data, 3,263,523 rows in the reported bounded-NDVI
  population, and 1,406,804 validation rows.
- The parquet contains 4,780,347 unique spatial point identifiers. The remaining
  40,058 observations repeat locations across different image pairs; repeated
  locations remain in the same train or validation partition.

## Table 1

- Recalculation reproduces the manuscript's unharmonized NDVI RMSE of 0.0598
  when validation observations are restricted by ETM+ NDVI from 0 to 1.
- Recalculated direct-index EVI and MSAVI mean differences are slightly
  negative, whereas Table 1 prints the corresponding rounded values as
  positive. The residual convention in the analysis code is prediction minus
  observed OLI.

## View geometry

The parquet does not contain view-zenith-angle measurements. Tables S3-S4 infer
the side of the paired swaths from whether the Landsat 8 acquisition occurred
one day before or after Landsat 7. The manuscript currently describes these
groups using signed view-zenith-angle differences.

## Park trends

- The displayed Figure 3 and S4 proportions use p-value cutoffs of 0.005 and
  0.025, while the manuscript describes two-sided cutoffs of 0.01 and 0.05.
- The exact Climate Engine Landsat QA implementation used for the original
  trend products was not retained. The extraction script contains the mask
  available in the archived analysis.
- The NPS boundary file used by the R plotting analysis is not distributed.

## Hydroclimate analysis

The Earth Engine JavaScript files document the Landsat and gridMET-DROUGHT
exports. Confirm that the final regional Landsat script implements the three
Level III ecoregions and the modal NLCD and MTBS burn masks described in the
manuscript before publication.

## SIMS analysis

- The harmonized SIMS collection is restricted. The workflow used to create
  that collection is not present in this repository.
- The Figure 5 code calculates percent difference relative to harmonized ET,
  while the manuscript describes percent difference relative to the
  operational, unharmonized product.

## Explorer

The explorer includes CONUS, ecoregion, watershed, and land-cover coefficient
sets generated with its own finite-value screening rules. Those coefficients
should not be treated as the frozen Table 1 or Table S5 analysis.
