import assert from 'node:assert';
import test from 'node:test';

import TileLayer from 'ol/layer/Tile.js';
import {get as getProjection} from 'ol/proj.js';
import XYZ from 'ol/source/XYZ.js';
import {tileLayerToImageryLayer} from './core.js';

type TestRectangle = {
  west: number;
  south: number;
  east: number;
  north: number;
};

const maxValueRectangle: TestRectangle = {
  west: -Math.PI,
  south: -Math.PI / 2,
  east: Math.PI,
  north: Math.PI / 2,
};

function installCesiumStub() {
  globalThis.Cesium = {
    ImageryLayer: class {
      imageryProvider: unknown;
      options: {rectangle: TestRectangle};

      constructor(provider: unknown, options: {rectangle: TestRectangle}) {
        this.imageryProvider = provider;
        this.options = options;
      }
    },
    Rectangle: {
      MAX_VALUE: maxValueRectangle,
      fromDegrees: (
        west: number,
        south: number,
        east: number,
        north: number,
      ) => ({west, south, east, north}),
    },
  } as typeof Cesium;
}

function createLayer(provider: unknown) {
  const source = new XYZ({url: '/{z}/{x}/{y}.png'});
  source.set('olcs_provider', provider);
  return new TileLayer({source});
}

function getLayerRectangle(layer: unknown): TestRectangle {
  return (layer as {options: {rectangle: TestRectangle}}).options.rectangle;
}

test('tileLayerToImageryLayer uses forced olcs_extent before provider rectangle', () => {
  installCesiumStub();
  const providerRectangle = {west: 10, south: 20, east: 30, north: 40};
  const layer = createLayer({rectangle: providerRectangle});
  layer.set('olcs_extent', [1, 2, 3, 4]);

  const cesiumLayer = tileLayerToImageryLayer(
    null,
    layer,
    getProjection('EPSG:4326'),
  );

  assert.deepStrictEqual(getLayerRectangle(cesiumLayer), {
    west: 1,
    south: 2,
    east: 3,
    north: 4,
  });
});

test('tileLayerToImageryLayer falls back to provider tiling scheme rectangle', () => {
  installCesiumStub();
  const tilingSchemeRectangle = {west: 1, south: 2, east: 3, north: 4};
  const layer = createLayer({
    rectangle: {west: Number.NaN, south: 0, east: 1, north: 1},
    tilingScheme: {rectangle: tilingSchemeRectangle},
  });

  const cesiumLayer = tileLayerToImageryLayer(
    null,
    layer,
    getProjection('EPSG:4326'),
  );

  assert.strictEqual(getLayerRectangle(cesiumLayer), tilingSchemeRectangle);
});

test('tileLayerToImageryLayer falls back to Cesium Rectangle MAX_VALUE', () => {
  installCesiumStub();
  const layer = createLayer({rectangle: null, tilingScheme: null});

  const cesiumLayer = tileLayerToImageryLayer(
    null,
    layer,
    getProjection('EPSG:4326'),
  );

  assert.strictEqual(getLayerRectangle(cesiumLayer), maxValueRectangle);
});

test('tileLayerToImageryLayer ignores invalid extent rectangles', () => {
  installCesiumStub();
  const providerRectangle = {west: 5, south: 6, east: 7, north: 8};
  const layer = createLayer({rectangle: providerRectangle});
  layer.set('olcs_extent', [Number.NaN, 2, 3, 4]);

  const cesiumLayer = tileLayerToImageryLayer(
    null,
    layer,
    getProjection('EPSG:4326'),
  );

  assert.strictEqual(getLayerRectangle(cesiumLayer), providerRectangle);
});
