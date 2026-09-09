
var geometry = 
    ee.Geometry.Polygon(
        [[[-117.93320206354535, 43.134926052542795],
          [-117.93320206354535, 37.92888333834977],
          [-115.12070206354535, 37.92888333834977],
          [-115.12070206354535, 43.134926052542795]]], null, false);

// Study region
var eco = ee.FeatureCollection("EPA/Ecoregions/2013/L3");

var gb = eco.filterBounds(geometry);

var eco_name = 'Great_Basin';

Map.addLayer(gb, {}, 'Great Basin ecoregions');

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

// The `merged` series combines Landsat 5, 7, 8, and 9.
// The `sensor` series processes each sensor separately.
var landsat_requests = [
  {series: 'merged', product: 'LANDSAT_SR', sensor: 'LANDSAT_5_7_8_9_SR'},
  {series: 'sensor', product: 'LANDSAT5_SR', sensor: 'LANDSAT5_SR'},
  {series: 'sensor', product: 'LANDSAT7_SR', sensor: 'LANDSAT7_SR'},
  {series: 'sensor', product: 'LANDSAT8_SR', sensor: 'LANDSAT8_SR'},
  {series: 'sensor', product: 'LANDSAT9_SR', sensor: 'LANDSAT9_SR'}
];

var region = gb.geometry().simplify(50);

var export_description = 'Landsat_SR_NDVI_' +
  start_year + '_' +
  end_year + '_' +
  eco_name
    .replace('/', '_')
    .replace(' ', '_')
    .replace(' ', '_')
    .replace(' ', '_')
    .replace(' ', '_')
    .replace(',', '')
    .replace(',', '')
    .replace(' ', '_')
    .replace(' ', '_') +
  '_casestudy';


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


// Landsat collection builders
function singleLandsatSr(product) {
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
    .filterBounds(region)
    .map(landsatQaPixelCloudMask);

  return collection.map(bandFunc);
}

function landsatSrCollection(product) {
  if (product === 'LANDSAT_SR') {
    return ee.ImageCollection([])
      .merge(singleLandsatSr('LANDSAT9_SR'))
      .merge(singleLandsatSr('LANDSAT8_SR'))
      .merge(singleLandsatSr('LANDSAT7_SR'))
      .merge(singleLandsatSr('LANDSAT5_SR'));
  }

  return singleLandsatSr(product);
}

// Variable calculation and annual compositing
function landsatVariable(img, variable) {
  if (variable === 'NDVI') {
    return img
      .normalizedDifference(['nir', 'red'])
      .rename('NDVI')
      .copyProperties(img, prop);
  }
}

function getCollectionAndVariable(product, variable) {
  return landsatSrCollection(product).map(function(img) {
    return landsatVariable(img, variable);
  });
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
    ee.Image.constant(0).updateMask(ee.Image.constant(0))
  )).rename('var');

  return statImage.set({
    n_images: nImages,
    year: year,
    date_start: start.format('YYYY-MM-dd'),
    date_end: end.format('YYYY-MM-dd'),
    'system:time_start': ee.Date.fromYMD(year, 1, 1).millis()
  });
}

function annualStatisticCollection(req) {
  var collection = getCollectionAndVariable(req.product, variable);

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
