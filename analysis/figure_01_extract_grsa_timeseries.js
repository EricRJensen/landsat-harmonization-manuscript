var geometry = 
    ee.Geometry.Polygon(
        [[[-105.67844869513591, 37.9881960047538],
          [-105.67844869513591, 37.762723639599265],
          [-105.51365377326091, 37.762723639599265],
          [-105.51365377326091, 37.9881960047538]]], null, false);

// Study region
var nps = ee.FeatureCollection("projects/nps-waterforecosystems/assets/nps-admin/nps-admin-boundaries")

var gs = nps.filterBounds(geometry).geometry().dissolve(10);
Map.addLayer(gs)

var nps_name = 'Great_Sand_Dunes';

// Analysis settings
var start_year = 1984;
var end_year = 2025;

var start_month = 4;
var start_day = 1;
var end_month = 9;
var end_day = 30;

var variable = 'NDVI';
var statistic = 'Mean';

var scale = 30;

var export_folder = 'landsat_harmonization_sensitivity_casestudy';

var prop = ['system:index', 'system:time_start'];

// `harmonization: 'none'` exports the original reflectance-derived NDVI.
// `harmonization: 'l7_to_l8'` calculates NDVI first, then adjusts Landsat 5/7
// NDVI to Landsat 8/9-like NDVI using the index-level polynomial correction.
var landsat_requests = [
  {series: 'merged_unharmonized', product: 'LANDSAT_SR', sensor: 'LANDSAT_5_7_8_9_SR', harmonization: 'none'},
  {series: 'merged_harmonized', product: 'LANDSAT_SR', sensor: 'LANDSAT_5_7_8_9_SR', harmonization: 'l7_to_l8'},

  {series: 'sensor_unharmonized', product: 'LANDSAT5_SR', sensor: 'LANDSAT5_SR', harmonization: 'none'},
  {series: 'sensor_unharmonized', product: 'LANDSAT7_SR', sensor: 'LANDSAT7_SR', harmonization: 'none'},
  {series: 'sensor_unharmonized', product: 'LANDSAT8_SR', sensor: 'LANDSAT8_SR', harmonization: 'none'},
  {series: 'sensor_unharmonized', product: 'LANDSAT9_SR', sensor: 'LANDSAT9_SR', harmonization: 'none'},

  {series: 'sensor_harmonized', product: 'LANDSAT5_SR', sensor: 'LANDSAT5_SR', harmonization: 'l7_to_l8'},
  {series: 'sensor_harmonized', product: 'LANDSAT7_SR', sensor: 'LANDSAT7_SR', harmonization: 'l7_to_l8'},
  {series: 'sensor_harmonized', product: 'LANDSAT8_SR', sensor: 'LANDSAT8_SR', harmonization: 'l7_to_l8'},
  {series: 'sensor_harmonized', product: 'LANDSAT9_SR', sensor: 'LANDSAT9_SR', harmonization: 'l7_to_l8'}
];

var region = gs.simplify(50);

var export_description = 'Landsat_SR_NDVI_' +
  start_year + '_' +
  end_year + '_' +
  nps_name
    .replace('/', '_')
    .replace(' ', '_')
    .replace(' ', '_')
    .replace(' ', '_')
    .replace(' ', '_')
    .replace(',', '')
    .replace(',', '')
    .replace(' ', '_')
    .replace(' ', '_') +
  '_casestudy_v1';


// Landsat preprocessing functions
function landsatQaPixelCloudMask(img) {
  var qa = img.select('QA_PIXEL');

  var cloudMask = qa.rightShift(3).bitwiseAnd(1).neq(0)
    .or(qa.rightShift(2).bitwiseAnd(1).neq(0))
    .or(qa.rightShift(4).bitwiseAnd(1).neq(0))
    .or(qa.rightShift(5).bitwiseAnd(1).neq(0))
    .or(qa.rightShift(1).bitwiseAnd(1).neq(0));

  return img.updateMask(cloudMask.not());
}

function landsat57SrBands(img) {
  var optical = img
    .select(
      ['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'],
      ['blue', 'green', 'red', 'nir', 'swir1', 'swir2']
    )
    .multiply(0.0000275)
    .add(-0.2);

  var lst = img
    .select('ST_B6')
    .multiply(0.00341802)
    .add(149.0)
    .rename('lst');

  return optical
    .addBands(lst)
    .addBands(img.select('QA_PIXEL'))
    .copyProperties(img, prop);
}

function landsat89SrBands(img) {
  var optical = img
    .select(
      ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
      ['blue', 'green', 'red', 'nir', 'swir1', 'swir2']
    )
    .multiply(0.0000275)
    .add(-0.2);

  var lst = img
    .select('ST_B10')
    .multiply(0.00341802)
    .add(149.0)
    .rename('lst');

  return optical
    .addBands(lst)
    .addBands(img.select('QA_PIXEL'))
    .copyProperties(img, prop);
}

// Landsat 5/7 to Landsat 8/9 NDVI harmonization
// Coefficients are applied to NDVI after the index is calculated from scaled
// surface reflectance bands.
// OLI-like NDVI = 0.0055 + 1.2289 * ETM_NDVI - 0.3197 * ETM_NDVI^2
//                 + 0.0575 * ETM_NDVI^3
// This correction is applied only to Landsat 5/7 when harmonization is requested.
// Landsat 8/9 are already the target reference family and are left unchanged.
function applyL7ToL8NdviHarmonization(img) {
  var ndvi = img.select('NDVI').toFloat();

  var ndviHarmonized = ee.Image.constant(0.0055)
    .add(ndvi.multiply(1.2289))
    .add(ndvi.pow(2).multiply(-0.3197))
    .add(ndvi.pow(3).multiply(0.0575))
    .rename('NDVI')
    .toFloat();

  return img
    .addBands(ndviHarmonized, null, true)
    .toFloat()
    .copyProperties(img, prop);
}


// Landsat collection builders
function singleLandsatSr(product, harmonization) {
  var asset;
  var bandFunc;

  if (product === 'LANDSAT5_SR') {
    asset = 'LANDSAT/LT05/C02/T1_L2';
    bandFunc = landsat57SrBands;
  } else if (product === 'LANDSAT7_SR') {
    asset = 'LANDSAT/LE07/C02/T1_L2';
    bandFunc = landsat57SrBands;
  } else if (product === 'LANDSAT8_SR') {
    asset = 'LANDSAT/LC08/C02/T1_L2';
    bandFunc = landsat89SrBands;
  } else if (product === 'LANDSAT9_SR') {
    asset = 'LANDSAT/LC09/C02/T1_L2';
    bandFunc = landsat89SrBands;
  } else {
    throw new Error('Unsupported Landsat product: ' + product);
  }

  var collection = ee.ImageCollection(asset)
    .filterBounds(region);
  
  // Landsat 7 observations after 2021 are excluded from the analysis.
  if (product === 'LANDSAT7_SR') {
    collection = collection.filterDate('1999-01-01', '2022-01-01');
  }
  
  collection = collection
    .map(landsatQaPixelCloudMask)
    .map(bandFunc);

  return collection;
}

function landsatSrCollection(product, harmonization) {
  if (product === 'LANDSAT_SR') {
    return ee.ImageCollection([])
      .merge(singleLandsatSr('LANDSAT9_SR', harmonization))
      .merge(singleLandsatSr('LANDSAT8_SR', harmonization))
      .merge(singleLandsatSr('LANDSAT7_SR', harmonization))
      .merge(singleLandsatSr('LANDSAT5_SR', harmonization));
  }

  return singleLandsatSr(product, harmonization);
}


// Variable calculation and annual compositing
function landsatVariable(img, variable) {
  if (variable === 'NDVI') {
    return img
      .normalizedDifference(['nir', 'red'])
      .rename('NDVI')
      .toFloat()
      .copyProperties(img, prop);
  }
}

// Build a single-sensor collection with the requested variable calculated.
// For harmonized NDVI requests, Landsat 5/7 NDVI is adjusted at the index level
// after NDVI is calculated. Landsat 8/9 are left unchanged.
function singleLandsatVariableCollection(product, variable, harmonization) {
  var collection = singleLandsatSr(product, harmonization).map(function(img) {
    return landsatVariable(img, variable);
  });

  if (
    variable === 'NDVI' &&
    harmonization === 'l7_to_l8' &&
    (product === 'LANDSAT5_SR' || product === 'LANDSAT7_SR')
  ) {
    collection = collection.map(applyL7ToL8NdviHarmonization);
  }

  return collection;
}

function getCollectionAndVariable(product, variable, harmonization) {
  if (product === 'LANDSAT_SR') {
    return ee.ImageCollection([])
      .merge(singleLandsatVariableCollection('LANDSAT9_SR', variable, harmonization))
      .merge(singleLandsatVariableCollection('LANDSAT8_SR', variable, harmonization))
      .merge(singleLandsatVariableCollection('LANDSAT7_SR', variable, harmonization))
      .merge(singleLandsatVariableCollection('LANDSAT5_SR', variable, harmonization));
  }

  return singleLandsatVariableCollection(product, variable, harmonization);
}

function reduceCollection(collection, statistic) {
  var stat = statistic.toLowerCase();

  if (stat === 'mean') {
    return collection.mean();
  }
}

function annualStatistic(collection, year, statistic) {
  year = ee.Number(year);

  var start = ee.Date.fromYMD(year, start_month, start_day);
  var end = ee.Date.fromYMD(year, end_month, end_day);

  var season = collection.filterDate(start, end);

  var nImages = season.size();

  var statImage = ee.Image(ee.Algorithms.If(
    nImages.gt(0),
    reduceCollection(season, statistic),
    ee.Image.constant(0).toFloat().updateMask(ee.Image.constant(0))
  )).rename('var').toFloat();

  return statImage.set({
    n_images: nImages,
    year: year,
    date_start: start.format('YYYY-MM-dd'),
    date_end: end.format('YYYY-MM-dd'),
    'system:time_start': ee.Date.fromYMD(year, 1, 1).millis()
  });
}

function annualStatisticCollection(req) {
  var collection = getCollectionAndVariable(
    req.product,
    variable,
    req.harmonization
  );

  var years = ee.List.sequence(start_year, end_year);

  return ee.ImageCollection(years.map(function(year) {
    return annualStatistic(collection, year, statistic);
  }))
  .filter(ee.Filter.gt('n_images', 0));
}

// Convert annual images to table features
function annualTimeSeriesFeatures(req) {
  var annual = annualStatisticCollection(req);
  var imageList = annual.toList(annual.size());

  return ee.FeatureCollection(imageList.map(function(image) {
    image = ee.Image(image);

    var value = image.select('var').reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: region,
      scale: scale,
      maxPixels: 1e13
    }).get('var');

    return ee.Feature(null, {
      series: req.series,
      product: req.product,
      sensor: req.sensor,
      harmonization: req.harmonization,
      variable: variable,
      statistic: statistic,
      year: image.get('year'),
      date_start: image.get('date_start'),
      date_end: image.get('date_end'),
      n_images: image.get('n_images'),
      value: value
    });
  }));
}

function mergeFeatureCollections(collections) {
  var merged = ee.FeatureCollection([]);

  collections.forEach(function(fc) {
    merged = merged.merge(fc);
  });

  return merged;
}


// Build final export table
var tables = landsat_requests.map(function(req) {
  return annualTimeSeriesFeatures(req);
});

var exportTable = mergeFeatureCollections(tables);

// Export table to Google Drive
Export.table.toDrive({
  collection: exportTable,
  description: export_description,
  folder: export_folder,
  fileNamePrefix: export_description,
  fileFormat: 'CSV'
});
