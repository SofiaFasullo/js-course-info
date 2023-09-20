import * as L from 'https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.esm.js';
import * as csv from 'https://www.unpkg.com/csv-parse@5.5.0/dist/esm/sync.js';
import * as d3ScaleChromatic from 'https://cdn.skypack.dev/d3-scale-chromatic@3';

const d3 = {
  ...d3ScaleChromatic,
};

//
// Create the map object and a base tile layer.
//

/**
 * Create the map object and a base tile layer.
 *
 * @return {L.Map} The map
 */
function initMap() {
  const map = L.map('map', {preferCanvas: true, zoomSnap: 0, zoomDelta: 0.5}).setView([39.99, -75.15], 11);

  L.tileLayer('https://api.mapbox.com/styles/v1/{username}/{styleId}/tiles/{tileSize}/{z}/{x}/{y}{r}?access_token={apiKey}', {
    username: 'mapbox',
    styleId: 'light-v11',
    tileSize: 512,
    zoomOffset: -1,
    apiKey: 'pk.eyJ1IjoibWp1bWJlLXRlc3QiLCJhIjoiY2w3ZTh1NTIxMTgxNTQwcGhmODU2NW5kaSJ9.pBPd19nWO-Gt-vTf1pOHBA',

    // Standard Mapbox attribution from https://docs.mapbox.com/help/getting-started/attribution/#other-mapping-frameworks
    attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> © <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> <strong><a href="https://www.mapbox.com/map-feedback/" target="_blank">Improve this map</a></strong>',
  }).addTo(map);

  return map;
}

//
// Download geographic and demographic data.
//

/**
 * Download and index the demographic data as a CSV. Each record of the CSV
 * contains the census variables P10_001N - P10_009N, followed by information
 * to construct a GeoID (state, county, tract, and block).
 *
 * @return {object} An object literal mapping from Census GEOIDs to arrays of
 *                  demographic values.
 */
async function downloadDemographicData() {
  const dmgResp = await fetch('../data/phl_block_dmg.csv');
  const dmgText = await dmgResp.text();
  const dmg = csv.parse(dmgText, {
    columns: false, // Don't generate object literals -- just use arrays
    from_line: 2, // Skip the first line (the header)
  });

  const dmgByGeoid = dmg.reduce((acc, record) => {
    const [state, county, tract, bg] = record.slice(record.length - 4);
    const geoid = `${state}${county}${tract}${bg}`;
    acc[geoid] = record.slice(0, record.length - 4);
    return acc;
  }, {});

  return dmgByGeoid;
}

/**
 * Download Philadelphia Census geography GeoJSON.
 *
 * @return {FeatureCollection} A feature collection representing block
 *                             geographies in Philadelphia.
 */
async function downloadGeographicData() {
  const geoResp = await fetch('../data/phl_blocks.geojson');
  const geoJson = await geoResp.json();

  return geoJson;
}

//
// Create the JSON layer
//

const RACE_LABELS = [
  'White',
  'Black or African American',
  'American Indian and Alaska Native',
  'Asian',
  'Native Hawaiian and Other Pacific Islander',
  'Some Other Race',
  'Two or More Races',
];

/**
 * Find the maximal item in an array, according to some key function.
 *
 * @param {Array} arr The array to search through
 * @param {Function} fn Optional. The key function to construct comparable
 *                      values. If not specified, the value of the array items
 *                      themselves will be compared.
 * @return {object} An object with the maximal item, the item's index, and the
 *                  compared value.
 */
function maximal(arr, fn) {
  return arr.reduce((maxInfo, item, index) => {
    const value = fn ? fn(item) : item;

    if (maxInfo === null || value > maxInfo.value) {
      return { value, item, index };
    }

    return maxInfo;
  }, null);
}

/**
 * Get the GeoID of a given block.
 *
 * @param {Feature} feature A feature representing the Census block
 * @return {string} The GeoID of the block.
 */
function getGeoID(feature) {
  return feature.properties['GEOID20'];
}

/**
 * Calculate demographic summary information for a given block record.
 *
 * @param {Array} dmgRecord An array of demographic information, as loaded
 *                          from a CSV
 * @return {object} An object with demographic summary information
 */
function getDemographicSummary(dmgRecord) {
  const [totalPop, , ...racePops] = dmgRecord.map((x) => 1 * x);

  if (totalPop <= 2) {
    return null;
  }

  const {value: largestRacePop, index: largestRaceIndex} = maximal(racePops);
  const largestRaceLabel = RACE_LABELS[largestRaceIndex];
  return {
    totalPop,
    largestRacePop,
    largestRaceIndex,
    largestRaceLabel,
  };
}

/**
 * Construct a path options object for use in styling GeoJSON features.
 *
 * @param {Feature} feature A Census block feature
 * @param {Array} dmgData Census demographic data, indexed on GeoID
 * @return {object} Path options for a GeoJSON feature style
 */
function calcFeatureStyle(feature, dmgData) {
  const colors = d3.schemeCategory10;

  const geoid = getGeoID(feature);
  const record = dmgData[geoid];
  const summary = getDemographicSummary(record);

  if (summary === null) {
    return {
      fill: false,
      stroke: false,
    };
  }

  const largestRacePortion = 1.0 * summary.largestRacePop / summary.totalPop;
  const minSegregatedPortion = 0.65;

  const color = colors[summary.largestRaceIndex];
  const opacity = Math.max(0, (largestRacePortion - minSegregatedPortion) / (1 - minSegregatedPortion));

  return {
    fillColor: color,
    fillOpacity: opacity,
    stroke: true,
    opacity: opacity / 2,
    color: color,
    weight: 1,
  };
}

function initDataLayer(geoData, dmgData) {
  const dataLayer = L.geoJSON(geoData, {
    style: (f) => calcFeatureStyle(f, dmgData),
  });

  dataLayer.bindTooltip((l) => {
    const geoid = getGeoID(l.feature);
    const record = dmgData[geoid];
    const summary = getDemographicSummary(record);

    return `
      ${(summary.largestRacePop * 100.0 / summary.totalPop).toFixed(1)}% ${summary.largestRaceLabel}<br>
      (out of ${summary.totalPop} adults)
    `;
  });

  return dataLayer;
}

function initLegend() {
  const legend = L.control({position: 'bottomright'});

  legend.onAdd = (map) => {
    const div = L.DomUtil.create('div', 'info legend');
    const races = RACE_LABELS;
    const colors = d3.schemeCategory10;

    // Loop through the races and generate a label and colored square for each
    let html = '<ul class="legend-entries">';
    for (let i = 0; i < races.length; i++) {
      html += `
        <li class="legend-entry">
          <span class="legend-icon" style="background-color: ${colors[i]};"></span>
          <span class="legend-label">${races[i]}</span>
        </li>
      `;
    }
    html += '</ul>';
    div.innerHTML = html;

    return div;
  };

  return legend;
}

const map = initMap();
const [geoData, dmgData] = await Promise.all([
  downloadGeographicData(),
  downloadDemographicData(),
]);
const dataLayer = initDataLayer(geoData, dmgData);
const legend = initLegend();

legend.addTo(map);
dataLayer.addTo(map);
map.flyToBounds(dataLayer.getBounds(), {duration: 1});

Object.assign(window, {
  map,
  geoData,
  dmgData,
  dataLayer,
  d3,
});