# Additions to Library

This fork adds support for four OpenLayers layer types in ol-cesium:

MVTWMSSynchronizer — Bridges “MVT over WMS-style” endpoints into Cesium. Requests tiles for the current view, honors server params, and renders them in 3D.

HeatmapSynchronizer — OL heatmaps on the globe. Renders in screen-space to a lightweight overlay, follows the camera during interaction (pan/zoom/tilt) via an affine transform, and recomputes once on moveEnd. Respects radius, blur, gradient, opacity, and per-feature weight. Includes kernel/palette caching and DPR scaling.

VectorImageSynchronizer — Adds Cesium support for ol/layer/VectorImage. Converts features to Cesium primitives, keeps visibility/style/declutter in sync, and cleans up old billboards/labels to avoid “ghost” artifacts. Zoom work is bucketed so simple pans don’t trigger rebuilds.

VectorImageClusterSynchronizer — Clustered vectors on VectorImage. Wires the cluster source to the inner vector loader, sets the current resolution, forces recluster on zoom-bucket changes, and repopulates Cesium via feature events. Prevents stale clusters and avoids over-fetch on pans.

## Aims for this work

Tilt-safe heatmaps that visually match OL (no geodetic smearing).

Correct cluster re-evaluation on zoom (with live inner-source refresh).

No label smearing: robust teardown of Cesium collections on updates.

Fewer unnecessary reloads: zoom-bucket gating and light throttling.

Drop-in usage: OLCesium.ts registers these synchronizers; add your OL layers as usual and enable ol-cesium.

# OpenLayers - Cesium library

OLCS is an opensource JS library for making [OpenLayers](https://openlayers.org/) and [CesiumJS](https://cesium.com/platform/cesiumjs/) works together, in the same application.
It addresses several use-cases:

- [Adding 3D to an existing OpenLayers map](#Adding 3D to an existing OpenLayers map)
- [Extending CesiumJS with new capabilities](#Extending CesiumJS with new capabilities)
- [Cherry-picking the pieces you need](#Cherry-picking the pieces you need)

See [live examples](https://openlayers.org/ol-cesium/examples/).

The npm package is called [olcs](https://www.npmjs.com/package/olcs).
Note that CesiumJS is accessed through the global `window.Cesium` object.

## Features

Switch smoothly between 2D and 3D and synchronize:

- Map context (bounding box and zoom level);
- Raster data sources;
- Vector data sources in 2D and 3D;
- Map selection (selected items);
- Animated transitions between map and globe view.

The library is configurable and extensible and allows:

- Lazy or eager loading of Cesium
- Limiting Cesium resource consumption (idle detection)

For synchronization of maps in projections other than EPSG:4326 and EPSG:3857 you need 2 datasets, see the customProj example.

## Adding 3D to an existing OpenLayers map

```js
// Create an OpenLayers map or start from an existing one.
import Map from 'ol/Map.js';
const ol2dMap = new Map({
    ...
});
ol2dMap.addLayer(....)
```

```js
// Pass the map to the OL-Cesium constructor
// OL-Cesium will create and synchronize a 3D CesiumJs globe from your layers and data.
import OLCesium from 'olcs';
const ol3d = new OLCesium({map: ol2dMap});
```

```js
ol3d.setEnabled(true); // switch to 3D - show the globe
ol3d.setEnabled(false); // switch to 2D - show the map
```

Build with your prefered bundler.

You can use any version of CesiumJS: latest upstream, a fork...
Simply provide it as `window.Cesium` global:

```html
<script src="https://cesium.com/downloads/cesiumjs/releases/1.113/Build/Cesium/Cesium.js"></script>
```

## Extending CesiumJS with new capabilities

```js
// Start from a CesiumJS globe
const viewer = getYourCesiumJSViewer();

// Add OpenLayers imagery provider
import {OLImageryProvider} from 'olcs';
viewer.scene.imageryLayers.addImageryProvider(new OLImageryProvider(...));

// Add Mapbox MVT imagery provider (client side rendering)
import {MVTImageryProvider} from 'olcs';
viewer.scene.imageryLayers.addImageryProvider(new MVTImageryProvider(...));
```

This is a bit limited at the moment but idea would be to implement:

- client side reprojection;
- full client side MVT rendering;
- GeoTIFF rendering;
- ... any feature available in OpenLayers.

## Cherry-picking the pieces you need

Specific low level functionnalities can be cherry-picked from the library.
For example:

```js
// GoogleMap rotating effect
import {rotateAroundBottomCenter} from 'olcs';
rotateAroundBottomCenter(viewer.scene, someAngle);
```

```ts
// convert OpenLayers Vector Layer to CesiumJS primitives
import {FeatureConverter} from 'olcs';
const converter = new FeatureConverter(viewer.scene);
const featurePrimitiveMap: Record<number, PrimitiveCollection> = {};
const counterpart: VectorLayerCounterpart = this.converter.olVectorLayerToCesium(olLayer, view, featurePrimitiveMap);
const csPrimitives = counterpart.getRootPrimitive();
viewer.scene.primitives.add(csPrimitives);
```

```js
// Even more powerful, use a synchronizer
import {VectorSynchronizer} from 'olcs';
const synchronizer = new VectorSynchronizer(ol2dMtheap, viewer.scene);
```

If you think some low level features should be spotlited here, open an issue and let's discuss it.

## Configuration

Use properties to control specific aspects of OL-Cesium integration, see the [PROPERTIES.MD](https://github.com/openlayers/ol-cesium/blob/master/PROPERTIES.md).

Also, check the [api doc](https://openlayers.org/ol-cesium/apidoc/).

## Limitations due to OpenLayers

There are a few limitations due to decisions on

- OpenLayers unmanaged layers are not discoverable and as a consequence not
supported. Plain layers should be used instead of the synchronization managed
manually. See https://github.com/openlayers/ol-cesium/issues/350.

- OpenLayers interactions are not supported in 3d. See https://github.com/openlayers/ol-cesium/issues/655.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
