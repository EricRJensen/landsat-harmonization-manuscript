
var geometry = 

    ee.Geometry.Polygon(
        [[[-118.57883114814759, 42.93138646536241],
          [-118.57883114814759, 38.53860098097383],
          [-114.88742489814759, 38.53860098097383],
          [-114.88742489814759, 42.93138646536241]]], null, false);

// Study region
var eco = ee.FeatureCollection("EPA/Ecoregions/2013/L3");

var gb = eco.filterBounds(geometry);

var eco_name = 'Great_Basin';

// Analysis settings
var start_year = 1984;
var end_year = 2025;

var variable = 'spei1y';

var scale = 4000;

var export_folder = 'landsat_harmonization_sensitivity_casestudy';

// Annual SPEI
var gmd = ee.ImageCollection("GRIDMET/DROUGHT")
  .select([variable]);

// This filters around late September / early October and averages the images
// within that short date window.
function generate_yearly_collection(year) {
  year = ee.Number(year);

  var start_date = year.format('%.0f').cat('-09-29');
  var end_date = year.format('%.0f').cat('-10-03');

  var year_gmd = gmd.filter(ee.Filter.date(start_date, end_date));

  return year_gmd
    .reduce(ee.Reducer.mean())
    .rename(variable)
    .set({
      year: year,
      'system:index': year.format('%.0f')
    });
}

var gmd_yearly = ee.ImageCollection(
  ee.List.sequence(start_year, end_year, 1).map(generate_yearly_collection)
).toBands();

print(gmd_yearly);


var region = gb.geometry().simplify(50);

var export_description = 'GridMET_SPEI1y_' +
  start_year + '_' +
  end_year + '_' +
  eco_name
    .replace('/', '_')
    .replace(' ', '_')
    .replace(' ', '_')
    .replace(' ', '_') +
  '_casestudy';

print(export_description);


// Reduce annual SPEI bands over the region
// The output is a single-row FeatureCollection where each column is a year-band.
var pdsi_stats = ee.FeatureCollection([
  ee.Feature(null, gmd_yearly.reduceRegion({
    geometry: region,
    reducer: ee.Reducer.mean(),
    scale: scale
  }))
]);


// Export table to Google Drive
Export.table.toDrive({
  collection: pdsi_stats,
  description: export_description,
  folder: export_folder,
  fileNamePrefix: export_description,
  fileFormat: 'CSV'
});
