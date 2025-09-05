import {getSourceProjection} from './util';
import {Tile as TileSource, type TileImage} from 'ol/source.js';
import {attributionsFunctionToCredits} from './core';
import type {Map, VectorTile} from 'ol';
import type {Projection} from 'ol/proj.js';
import type {Credit, Event, ImageryLayerFeatureInfo, ImageryProvider, ImageryTypes, Proxy, Rectangle, Request, TileDiscardPolicy, TilingScheme} from 'cesium';
import olSourceVectorTile from 'ol/source/VectorTile.js';
import RenderFeature from 'ol/render/Feature.js';
import MVT from 'ol/format/MVT.js';
import Style, {type StyleFunction} from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import {toContext} from 'ol/render.js';
import {VERSION as OL_VERSION} from 'ol/util.js';
import LRUCache from 'ol/structs/LRUCache.js';

export interface MVTWMSOptions {
  rectangle: Rectangle,
  styleFunction: StyleFunction,
  cacheSize?: number,
  featureCache?: LRUCache<Promise<RenderFeature[]>>
  minimumLevel: number
}

export function createEmptyCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

const format = new MVT({
  featureClass: RenderFeature
});

const styles = [new Style({
  stroke: new Stroke({
    color: 'blue',
    width: 2
  })
})];

const olUseNewCoordinates = (function() {
  const tileSource = new TileSource({
    projection: 'EPSG:3857',
    wrapX: true
  });
  const tileCoord = tileSource.getTileCoordForTileUrlFunction([6, -31, 22]);
  return tileCoord && tileCoord[1] === 33 && tileCoord[2] === 22;
  // See b/test/spec/ol/source/tile.test.js
  // of e9a30c5cb7e3721d9370025fbe5472c322847b35 in OpenLayers repository
})();


export default class MVTWMSImageryProvider implements ImageryProvider /* should not extend Cesium.ImageryProvider */ {
  private source_: olSourceVectorTile;
  private projection_: Projection | undefined;
  private fallbackProj_: Projection | undefined;
  private styleFunction_: StyleFunction;
  private map_: Map;
  private shouldRequestNextLevel: boolean;
  private emptyCanvas_: HTMLCanvasElement = createEmptyCanvas();
  private emptyCanvasPromise_: Promise<HTMLCanvasElement> = Promise.resolve(this.emptyCanvas_);
  private tilingScheme_: TilingScheme;
  private ready_: boolean;
  private rectangle_: Rectangle;
  private tileRectangle_: Rectangle;
  private minimumLevel_ = 0;
  private featureCache: LRUCache<Promise<RenderFeature[]>>;
  private tileCache: LRUCache<Promise<HTMLCanvasElement>>;
  /**
 * When <code>true</code>, this model is ready to render, i.e., the external binary, image,
 * and shader files were downloaded and the WebGL resources were created.
 */
  get ready(): boolean {
    return this.ready_;
  }

  /**
 * Gets the rectangle, in radians, of the imagery provided by the instance.
 */
  get rectangle() {
    return this.rectangle_;
  }

  /**
   * Gets the tiling scheme used by the provider.
   */
  get tilingScheme(): TilingScheme {
    return this.tilingScheme_;
  }

  /**
   * Gets an event that is raised when the imagery provider encounters an asynchronous error.  By subscribing
   * to the event, you will be notified of the error and can potentially recover from it.  Event listeners
   * are passed an instance of {@link Cesium.TileProviderError}.
   */
  readonly errorEvent: Event = new Cesium.Event();

  /**
   * Gets the credit to display when this imagery provider is active.  Typically this is used to credit
   * the source of the imagery.
   */
  readonly credit: Credit;

  /**
   * Gets the proxy used by this provider.
   */
  readonly proxy: Proxy;

  get _ready(): boolean {
    return this.ready_;
  }

  /**
   * Gets the width of each tile, in pixels.
   */
  get tileWidth(): number {
    const tileGrid = this.source_.getTileGrid();
    if (tileGrid) {
      const tileSizeAtZoom0 = tileGrid.getTileSize(0);
      if (Array.isArray(tileSizeAtZoom0)) {
        return tileSizeAtZoom0[0];
      } else {
        return tileSizeAtZoom0; // same width and height
      }
    }
    return 256;
  }

  /**
   * Gets the height of each tile, in pixels.
   */
  get tileHeight(): number {
    const tileGrid = this.source_.getTileGrid();
    if (tileGrid) {
      const tileSizeAtZoom0 = tileGrid.getTileSize(0);
      if (Array.isArray(tileSizeAtZoom0)) {
        return tileSizeAtZoom0[1];
      } else {
        return tileSizeAtZoom0; // same width and height
      }
    }
    return 256;
  }

  /**
   * Gets the maximum level-of-detail that can be requested.
   */
  get maximumLevel(): number {
    const tileGrid = this.source_.getTileGrid();
    if (tileGrid) {
      return tileGrid.getMaxZoom();
    } else {
      return 18; // some arbitrary value
    }
  }

  // FIXME: to implement, we could check the number of tiles at minzoom (for this rectangle) and return 0 if too big
  /**
   * Gets the minimum level-of-detail that can be requested.  Generally,
   * a minimum level should only be used when the rectangle of the imagery is small
   * enough that the number of tiles at the minimum level is small.  An imagery
   * provider with more than a few tiles at the minimum level will lead to
   * rendering problems.
   */
  get minimumLevel() {
    // WARNING: Do not use the minimum level (at least until the extent is
    // properly set). Cesium assumes the minimumLevel to contain only
    // a few tiles and tries to load them all at once -- this can
    // freeze and/or crash the browser !
    return this.minimumLevel_;
    //var tg = this.source_.getTileGrid();
    //return tg ? tg.getMinZoom() : 0;
  }

  /**
   * Gets the tile discard policy.  If not undefined, the discard policy is responsible
   * for filtering out "missing" tiles via its shouldDiscardImage function.  If this function
   * returns undefined, no tiles are filtered.
   */
  get tileDiscardPolicy(): TileDiscardPolicy {
    return undefined;
  }

  // FIXME: this might be exposed
  /**
   * Gets a value indicating whether or not the images provided by this imagery provider
   * include an alpha channel.  If this property is false, an alpha channel, if present, will
   * be ignored.  If this property is true, any images without an alpha channel will be treated
   * as if their alpha is 1.0 everywhere.  When this property is false, memory usage
   * and texture upload time are reduced.
   */
  get hasAlphaChannel() {
    return true;
  }

  // FIXME: this could be implemented by proxying to OL
  /**
   * Asynchronously determines what features, if any, are located at a given longitude and latitude within
   * a tile.
   * This function is optional, so it may not exist on all ImageryProviders.
   * @param x - The tile X coordinate.
   * @param y - The tile Y coordinate.
   * @param level - The tile level.
   * @param longitude - The longitude at which to pick features.
   * @param latitude - The latitude at which to pick features.
   * @return A promise for the picked features that will resolve when the asynchronous
   *                   picking completes.  The resolved value is an array of {@link ImageryLayerFeatureInfo}
   *                   instances.  The array may be empty if no features are found at the given location.
   *                   It may also be undefined if picking is not supported.
   */
  pickFeatures(x: number, y: number, level: number, longitude: number, latitude: number): Promise<ImageryLayerFeatureInfo[]> | undefined {
    return undefined;
  }

  /**
   * Special class derived from Cesium.ImageryProvider
   * that is connected to the given ol.source.TileImage.
   * @param olMap OL map
   * @param source Tile image source
   * @param [opt_fallbackProj] Projection to assume if source has no projection0
   */
  constructor(olMap: Map, source: olSourceVectorTile, opt_fallbackProj: Projection, options: MVTWMSOptions) {
    this.source_ = source;

    this.projection_ = null;

    this.ready_ = false;

    this.fallbackProj_ = opt_fallbackProj || null;

    // cesium v107+ don't wait for ready anymore so we put somehing here while it loads
    this.tilingScheme_ = new Cesium.WebMercatorTilingScheme();

    this.rectangle_ = options.rectangle || this.tilingScheme.rectangle;

    this.styleFunction_ = options.styleFunction || (() => styles);

    this.tileRectangle_ = new Cesium.Rectangle();

    // to avoid too frequent cache grooming we allow x2 capacity
    const cacheSize = options.cacheSize !== undefined ? options.cacheSize : 50;

    this.tileCache = new LRUCache(cacheSize);

    this.featureCache = options.featureCache || new LRUCache(cacheSize);

    this.minimumLevel_ = options.minimumLevel || 0;

    this.map_ = olMap;

    this.shouldRequestNextLevel = false;

    const proxy = this.source_.get('olcs.proxy');
    if (proxy) {
      if (typeof proxy === 'function') {
        // Duck typing a proxy
        this.proxy = {
          'getURL': proxy
        } as Proxy;
      } else if (typeof proxy === 'string') {
        this.proxy = new Cesium.DefaultProxy(proxy);
      }
    }

    this.source_.on('change', (e) => {
      this.handleSourceChanged_();
    });
    this.handleSourceChanged_();
  }

  /**
   * Checks if the underlying source is ready and cached required data.
   */
  private handleSourceChanged_() {
    if (!this.ready_ && this.source_.getState() == 'ready') {
      this.projection_ = getSourceProjection(this.source_) || this.fallbackProj_;
      const options = {numberOfLevelZeroTilesX: 1, numberOfLevelZeroTilesY: 1};

      if (this.source_.tileGrid !== null) {
        // Get the number of tiles at level 0 if it is defined
        this.source_.tileGrid.forEachTileCoord(this.projection_.getExtent(), 0, ([zoom, xIndex, yIndex]) => {
          options.numberOfLevelZeroTilesX = xIndex + 1;
          options.numberOfLevelZeroTilesY = yIndex + 1;
        });
      }

      if (this.projection_.getCode() === 'EPSG:4326') {
        // Cesium zoom level 0 is OpenLayers zoom level 1 for layer in EPSG:4326 with a single tile on level 0
        this.shouldRequestNextLevel = options.numberOfLevelZeroTilesX === 1 && options.numberOfLevelZeroTilesY === 1;
        this.tilingScheme_ = new Cesium.GeographicTilingScheme(options);
      } else if (this.projection_.getCode() === 'EPSG:3857') {
        this.shouldRequestNextLevel = false;
        this.tilingScheme_ = new Cesium.WebMercatorTilingScheme(options);
      } else {
        return;
      }
      if (!this.rectangle_)
        this.rectangle_ = this.tilingScheme_.rectangle;

      this.ready_ = true;
    }
  }

  /**
   * Generates the proper attributions for a given position and zoom
   * level.
   * @implements
   */
  getTileCredits(x: number, y: number, level: number): Credit[] {
    const attributionsFunction = this.source_.getAttributions();
    if (!attributionsFunction) {
      return [];
    }
    const extent = this.map_.getView().calculateExtent(this.map_.getSize());
    const center = this.map_.getView().getCenter();
    const zoom = this.shouldRequestNextLevel ? level + 1 : level;
    return attributionsFunctionToCredits(attributionsFunction, zoom, center, extent);
  }


  private getCacheKey_(z: number, x: number, y: number) {
    return `${z}_${x}_${y}`;
  }

  /**
   * @implements
   */
  requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> | undefined {
    if (level < this.minimumLevel_) {
      return this.emptyCanvasPromise_;
    }
    try {
      const cacheKey = this.getCacheKey_(level, x, y);
      let promise;
      if (this.tileCache.containsKey(cacheKey)) {
        promise = this.tileCache.get(cacheKey);
      }
      if (!promise) {
        const tileUrlFunction = this.source_.getTileUrlFunction();
        if (tileUrlFunction && this.projection_) {
          const z_ = this.shouldRequestNextLevel ? level + 1 : level;
          let y_ = y;
          if (!olUseNewCoordinates) {
            // LEGACY
            // OpenLayers version 3 to 5 tile coordinates increase from bottom to top
            y_ = -y - 1;
          }
          let url = tileUrlFunction.call(this.source_, [z_, x, y_], 1, this.projection_);
          if (this.proxy) {
            url = this.proxy.getURL(url);
          }
          if (url) {
            //console.log(url);
            // It is probably safe to cast here
            promise = this.getTileFeatures(url,level,x,y)
                .then((features) => {
                // FIXME: here we suppose the 2D projection is in meters
                  this.tilingScheme.tileXYToNativeRectangle(x, y, z_, this.tileRectangle_);
                  const resolution = (this.tileRectangle_.east - this.tileRectangle_.west) / this.tileWidth;
                  return this.rasterizeFeatures(features, this.styleFunction_, resolution);
                });
            this.tileCache.set(cacheKey, promise);
            if (this.tileCache.getCount() > 2 * this.tileCache.highWaterMark) {
              while (this.tileCache.canExpireCache()) {
                this.tileCache.pop();
              }
            }
          }
          else {
            promise = this.emptyCanvasPromise_;
          }
        }
      }
      return promise;
    } catch (e) {
      console.trace(e);
      // FIXME: open PR on Cesium to fix incorrect typing
      // @ts-ignore
      this.errorEvent.raiseEvent('could not render pbf to tile', e);
    }
  }

  private getTileFeatures(url: string,z: number, x: number, y: number): Promise<RenderFeature[]> {
    const cacheKey = this.getCacheKey_(z, x, y);
    let promise;
    if (this.featureCache.containsKey(cacheKey)) {
      promise = this.featureCache.get(cacheKey);
    }
    if (!promise) {
      promise = fetch(url)
          .then(r => (r.ok ? r : Promise.reject(r)))
          .then(r => r.arrayBuffer())
          .then(buffer => this.readFeaturesFromBuffer(buffer));
      this.featureCache.set(cacheKey, promise);
      if (this.featureCache.getCount() > 2 * this.featureCache.highWaterMark) {
        while (this.featureCache.canExpireCache()) {
          this.featureCache.pop();
        }
      }
    }
    return promise;
  }

  readFeaturesFromBuffer(buffer: ArrayBuffer): RenderFeature[] {
    let options;
    if (OL_VERSION <= '6.4.4') {
      // See https://github.com/openlayers/openlayers/pull/11540
      options = {
        extent: [0, 0, 4096, 4096],
        dataProjection: this.projection_,
        featureProjection: this.projection_
      };
    }
    const features = format.readFeatures(buffer, options) as RenderFeature[];
    const scaleFactor = this.tileWidth / 4096;
    features.forEach((f) => {
      const flatCoordinates = f.getFlatCoordinates();
      let flip = false;
      for (let i = 0; i < flatCoordinates.length; ++i) {
        flatCoordinates[i] *= scaleFactor;
        if (flip) {
          // FIXME: why do we need this now?
          flatCoordinates[i] = this.tileWidth - flatCoordinates[i];
        }
        if (OL_VERSION <= '6.4.4') {
          // LEGACY
          flip = !flip;
        }
      }
    });

    return features;
  }

  rasterizeFeatures(features: RenderFeature[], styleFunction: StyleFunction, resolution: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    const vectorContext = toContext(canvas.getContext('2d'), {size: [this.tileWidth, this.tileHeight]});
    features.forEach((f) => {
      const styles = styleFunction(f, resolution);
      if (styles) {
        if (Array.isArray(styles)) {
          styles.forEach((style) => {
            vectorContext.setStyle(style);
            vectorContext.drawGeometry(f);
          });
        } else {
          vectorContext.setStyle(styles);
          vectorContext.drawGeometry(f);
        }
      }
    });
    return canvas;
  }
}
