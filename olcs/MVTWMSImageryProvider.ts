import {getSourceProjection} from './util';
import {Tile as TileSource} from 'ol/source.js';
import {attributionsFunctionToCredits} from './core';
import type {Map} from 'ol';
import type {Projection} from 'ol/proj.js';
import type {
  Credit, Event, ImageryLayerFeatureInfo, ImageryProvider, ImageryTypes,
  Proxy, Rectangle, Request, TileDiscardPolicy, TilingScheme
} from 'cesium';
import olSourceVectorTile from 'ol/source/VectorTile.js';
import RenderFeature from 'ol/render/Feature.js';
import MVT from 'ol/format/MVT.js';
import Style, {type StyleFunction} from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import {toContext} from 'ol/render.js';
import LRUCache from 'ol/structs/LRUCache.js';
import {Point, LineString, MultiLineString, Polygon, MultiPolygon, MultiPoint} from 'ol/geom';

// NEW: reuse the stock OL → Cesium imagery bridge for WMS
import TileWMS from 'ol/source/TileWMS.js';
import {createXYZ} from 'ol/tilegrid.js';
import {get as getProj} from 'ol/proj';
import OLImageryProvider from './core/OLImageryProvider';

export interface MVTWMSOptions {
  rectangle: Rectangle,
  styleFunction: StyleFunction,
  cacheSize?: number,
  featureCache?: LRUCache<Promise<RenderFeature[]>>,
  minimumLevel: number
}

export function createEmptyCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

const format = new MVT({ featureClass: RenderFeature });

const styles = [new Style({
  stroke: new Stroke({ color: 'blue', width: 2 })
})];

const olUseNewCoordinates = (function() {
  const tileSource = new TileSource({ projection: 'EPSG:3857', wrapX: true });
  const tileCoord = tileSource.getTileCoordForTileUrlFunction([6, -31, 22]);
  return tileCoord && tileCoord[1] === 33 && tileCoord[2] === 22;
})();

export default class MVTWMSImageryProvider implements ImageryProvider {
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

  // Delegate to standard OLImageryProvider (TileWMS) if olcs_wmsFormat is set
  private olWmsDelegate_: OLImageryProvider | null = null;

  readonly errorEvent: Event = new Cesium.Event();
  readonly credit: Credit;
  readonly proxy: Proxy;

  get ready(): boolean { return this.ready_; }
  get rectangle() { return this.rectangle_; }
  get tilingScheme(): TilingScheme { return this.tilingScheme_; }
  get _ready(): boolean { return this.ready_; }

  get tileWidth(): number {
    if (this.olWmsDelegate_) return (this.olWmsDelegate_ as any).tileWidth;
    const tileGrid = this.source_.getTileGrid();
    if (tileGrid) {
      const t0 = tileGrid.getTileSize(0);
      return Array.isArray(t0) ? t0[0] : t0;
    }
    return 256;
  }

  get tileHeight(): number {
    if (this.olWmsDelegate_) return (this.olWmsDelegate_ as any).tileHeight;
    const tileGrid = this.source_.getTileGrid();
    if (tileGrid) {
      const t0 = tileGrid.getTileSize(0);
      return Array.isArray(t0) ? t0[1] : t0;
    }
    return 256;
  }

  get maximumLevel(): number {
    if (this.olWmsDelegate_) return (this.olWmsDelegate_ as any).maximumLevel ?? 18;
    const tileGrid = this.source_.getTileGrid();
    return tileGrid ? tileGrid.getMaxZoom() : 18;
  }

  get minimumLevel() {
    if (this.olWmsDelegate_) return (this.olWmsDelegate_ as any).minimumLevel ?? 0;
    return this.minimumLevel_;
  }

  get tileDiscardPolicy(): TileDiscardPolicy {
    if (this.olWmsDelegate_) return (this.olWmsDelegate_ as any).tileDiscardPolicy;
    return undefined;
  }

  get hasAlphaChannel() {
    if (this.olWmsDelegate_) return (this.olWmsDelegate_ as any).hasAlphaChannel ?? true;
    return true;
  }

  pickFeatures(x: number, y: number, level: number, longitude: number, latitude: number) {
    if (this.olWmsDelegate_ && (this.olWmsDelegate_ as any).pickFeatures) {
      return (this.olWmsDelegate_ as any).pickFeatures(x, y, level, longitude, latitude);
    }
    return undefined;
  }

  constructor(olMap: Map, source: olSourceVectorTile, opt_fallbackProj: Projection, options: MVTWMSOptions) {
    this.source_ = source;
    this.projection_ = undefined;
    this.ready_ = false;
    this.fallbackProj_ = opt_fallbackProj || null;

    this.tilingScheme_ = new Cesium.WebMercatorTilingScheme();
    this.rectangle_ = options.rectangle || (this.tilingScheme as any).rectangle;
    this.styleFunction_ = options.styleFunction || (() => styles);
    this.tileRectangle_ = new Cesium.Rectangle();

    const cacheSize = options.cacheSize !== undefined ? options.cacheSize : 50;
    this.tileCache = new LRUCache(cacheSize);
    this.featureCache = options.featureCache || new LRUCache(cacheSize);

    this.minimumLevel_ = options.minimumLevel || 0;
    this.map_ = olMap;
    this.shouldRequestNextLevel = false;

    const proxy = (this.source_ as any).get?.('olcs.proxy');
    if (proxy) {
      if (typeof proxy === 'function') {
        this.proxy = { getURL: proxy } as Proxy;
      } else if (typeof proxy === 'string') {
        this.proxy = new Cesium.DefaultProxy(proxy);
      }
    }

    this.source_.on('change', () => { this.handleSourceChanged_(); });
    this.handleSourceChanged_();
  }

  private handleSourceChanged_() {
    if (!this.ready_ && this.source_.getState() == 'ready') {
      this.projection_ = getSourceProjection(this.source_) || this.fallbackProj_;
      const options = { numberOfLevelZeroTilesX: 1, numberOfLevelZeroTilesY: 1 };

      if ((this.source_ as any).tileGrid !== null) {
        (this.source_ as any).tileGrid.forEachTileCoord(
          this.projection_.getExtent(),
          0,
          ([, xIndex, yIndex]: [number, number, number]) => {
            options.numberOfLevelZeroTilesX = xIndex + 1;
            options.numberOfLevelZeroTilesY = yIndex + 1;
          }
        );
      }

      if (this.projection_.getCode() === 'EPSG:4326') {
        this.shouldRequestNextLevel =
          options.numberOfLevelZeroTilesX === 1 && options.numberOfLevelZeroTilesY === 1;
        this.tilingScheme_ = new Cesium.GeographicTilingScheme(options);
      } else if (this.projection_.getCode() === 'EPSG:3857') {
        this.shouldRequestNextLevel = false;
        this.tilingScheme_ = new Cesium.WebMercatorTilingScheme(options);
      } else {
        return;
      }

      if (!this.rectangle_) this.rectangle_ = (this.tilingScheme as any).rectangle;
      this.ready_ = true;

      // Only redirect to WMS imagery if the app explicitly set a format override
      this.tryInitOlWmsDelegate_();
    }
  }

  getTileCredits(x: number, y: number, level: number): Credit[] {
    if (this.olWmsDelegate_ && (this.olWmsDelegate_ as any).getTileCredits) {
      return (this.olWmsDelegate_ as any).getTileCredits(x, y, level);
    }
    const attributionsFunction = this.source_.getAttributions();
    if (!attributionsFunction) return [];
    const extent = this.map_.getView().calculateExtent(this.map_.getSize());
    const center = this.map_.getView().getCenter();
    const zoom = this.shouldRequestNextLevel ? level + 1 : level;
    return attributionsFunctionToCredits(attributionsFunction, zoom, center, extent);
  }

  private getCacheKey_(z: number, x: number, y: number) {
    return `${z}_${x}_${y}`;
  }

  requestImage(x: number, y: number, z: number, request?: Request): Promise<ImageryTypes> | undefined {
    // Delegate to standard WMS imagery ONLY when olcs_wmsFormat is configured
    if (this.olWmsDelegate_) {
      return (this.olWmsDelegate_ as any).requestImage(x, y, z, request);
    }

    const z_ = this.shouldRequestNextLevel ? z + 1 : z;
    if (z < this.minimumLevel_) return this.emptyCanvasPromise_;
    try {
      const cacheKey = this.getCacheKey_(z_, x, y);
      let promise = this.tileCache.containsKey(cacheKey) ? this.tileCache.get(cacheKey) : undefined;

      if (!promise) {
        const tileUrlFunction = this.source_.getTileUrlFunction();
        if (tileUrlFunction && this.projection_) {
          let y_ = y;
          if (!olUseNewCoordinates) y_ = -y - 1; // legacy Y

          let url = tileUrlFunction.call(this.source_, [z_, x, y_], 1, this.projection_);
          if (this.proxy) url = this.proxy.getURL(url);

          promise = url
            ? this.getTileFeatures(url, z_, x, y).then((features) => {
                this.tilingScheme.tileXYToNativeRectangle(x, y, z_, this.tileRectangle_);
                // compute nominal resolution for styleFunction
                let resolution: number;
                if (this.projection_?.getCode() === 'EPSG:3857') {
                  const worldMeters = 2 * Math.PI * 6378137;
                  resolution = (worldMeters / this.tileWidth) / Math.pow(2, z_);
                } else {
                  const worldRadians = 2 * Math.PI;
                  resolution = (worldRadians / this.tileWidth) / Math.pow(2, z_);
                }
                return this.rasterizeFeatures(features, this.styleFunction_, resolution);
              })
            : this.emptyCanvasPromise_;

          if (promise) {
            this.tileCache.set(cacheKey, promise);
            if (this.tileCache.getCount() > 2 * this.tileCache.highWaterMark) {
              while (this.tileCache.canExpireCache()) this.tileCache.pop();
            }
          }
        }
      }
      return promise;
    } catch (e) {
      console.trace(e);
      // @ts-ignore
      this.errorEvent.raiseEvent('could not render pbf to tile', e);
    }
  }

  private getTileFeatures(url: string, z: number, x: number, y: number): Promise<RenderFeature[]> {
    const cacheKey = this.getCacheKey_(z, x, y);
    let promise = this.featureCache.containsKey(cacheKey) ? this.featureCache.get(cacheKey) : undefined;

    if (!promise) {
      const headersFn = (this.source_ as any)?.get?.('olcs_authHeaders');
      const headers = typeof headersFn === 'function' ? headersFn({ z, x, y }) : undefined;

      promise = fetch(url, { headers: headers ?? {} })
        .then(r => (r.ok ? r : Promise.reject(r)))
        .then(r => r.arrayBuffer())
        .then(buffer => this.readFeaturesFromBuffer(buffer));

      this.featureCache.set(cacheKey, promise);
      if (this.featureCache.getCount() > 2 * this.featureCache.highWaterMark) {
        while (this.featureCache.canExpireCache()) this.featureCache.pop();
      }
    }
    return promise;
  }

  // Do NOT mutate RenderFeatures here; keep them pristine for OL 2D.
  readFeaturesFromBuffer(buffer: ArrayBuffer): RenderFeature[] {
    return format.readFeatures(buffer) as RenderFeature[];
  }

  // ---- 3D rasterization (MVT → canvas) without mutating originals ----

  private flatToCoords_(flat: number[], ends: number[]): [number, number][] {
    const out: [number, number][] = [];
    let i = 0;
    for (const end of ends) {
      for (; i < end; i += 2) out.push([flat[i], flat[i + 1]]);
    }
    return out;
  }

  private cloneAndScaleGeometry_(
    f: RenderFeature, sx: number, sy: number
  ) {
    const src = f.getFlatCoordinates();
    if (!src) return null;

    const flat: number[] = new Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      flat[i]     = src[i] * sx;
      flat[i + 1] = src[i + 1] * sy; // no Y-flip; MVT + canvas are Y-down
    }

    const type = f.getType() as string;

    if (type === 'Point') {
      return new Point([flat[0], flat[1]]);
    }

    if (type === 'MultiPoint') {
      const pts: [number, number][] = [];
      for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
      return new MultiPoint(pts);
    }

    if (type === 'LineString') {
      const ends = (f.getEnds() as number[]) ?? [flat.length];
      return new LineString(this.flatToCoords_(flat, ends));
    }

    if (type === 'Polygon') {
      const ends = (f.getEnds() as number[]) ?? [flat.length];
      // split into rings
      const rings: [number, number][][] = [];
      let i = 0;
      for (const end of ends) {
        const ring: [number, number][] = [];
        for (; i < end; i += 2) ring.push([flat[i], flat[i + 1]]);
        rings.push(ring);
      }
      return new Polygon(rings);
    }

    const endss: number[][] | undefined = (f as any).getEndss?.();

    if (type === 'MultiLineString' && endss) {
      const lines = endss.map(ends => this.flatToCoords_(flat, ends));
      return new MultiLineString(lines);
    }

    if (type === 'MultiPolygon' && endss) {
      const polys: [number, number][][][] = [];
      for (const ends of endss) {
        const rings: [number, number][][] = [];
        let i = 0;
        for (const end of ends) {
          const ring: [number, number][] = [];
          for (; i < end; i += 2) ring.push([flat[i], flat[i + 1]]);
          rings.push(ring);
        }
        polys.push(rings);
      }
      return new MultiPolygon(polys);
    }

    // Fallback
    const ends = (f.getEnds() as number[]) ?? [flat.length];
    return new LineString(this.flatToCoords_(flat, ends));
  }

  rasterizeFeatures(features: RenderFeature[], styleFn: StyleFunction, resolution: number): HTMLCanvasElement {
    const MVT_EXTENT = 4096;
    const sx = this.tileWidth  / MVT_EXTENT;
    const sy = this.tileHeight / MVT_EXTENT;

    const canvas = document.createElement('canvas');
    canvas.width  = this.tileWidth;
    canvas.height = this.tileHeight;

    const vc = toContext(canvas.getContext('2d')!, { size: [this.tileWidth, this.tileHeight] });

    for (const f of features) {
      const g = this.cloneAndScaleGeometry_(f, sx, sy);
      if (!g) continue;

      const styles = styleFn(f, resolution);
      if (!styles) continue;

      const arr = Array.isArray(styles) ? styles : [styles];
      for (const s of arr) {
        vc.setStyle(s);
        vc.drawGeometry(g);
      }
    }
    return canvas;
  }

  // --------- WMS delegation (only when olcs_wmsFormat is set) ---------

  private cloneTileWms_(src: TileWMS, overrides: Record<string, any>) {
    const url =
      (src as any).getUrls?.()?.[0] ||
      (src as any).getUrl?.() ||
      (src as any).urls?.[0];

    const params = { ...(src as any).getParams?.(), ...overrides };

    const clone = new TileWMS({
      url,
      params,
      projection: (src as any).getProjection?.(),
      tileGrid:   (src as any).getTileGrid?.(),
      crossOrigin:(src as any).getCrossOrigin?.() ?? 'anonymous',
      serverType: (src as any).serverType_ || (src as any).get?.('serverType') || 'geoserver',
      transition: 0
    });

    // carry over attributions & proxy hints (optional)
    const attrs = (src as any).getAttributions?.();
    if (attrs && (clone as any).setAttributions) (clone as any).setAttributions(attrs);
    const olcs_proxy =
      (this.source_ as any).get?.('olcs_proxy') ??
      (this.source_ as any).get?.('olcs.proxy');
    if (olcs_proxy && (clone as any).set) (clone as any).set('olcs_proxy', olcs_proxy);

    // preserve custom tileLoadFunction (if you use it)
    const tlf = (src as any).getTileLoadFunction?.();
    if (tlf && (clone as any).setTileLoadFunction) (clone as any).setTileLoadFunction(tlf);

    // ✅ ensure auth headers are present:
    // prefer the base WMS' flag, else fall back to the VT source's flag
    const fromBase = (src as any).get?.('olcs_authHeaders');
    const fromVT   = this.getAuthHeadersFn_();
    const authFn = fromBase || fromVT;
    if (authFn && (clone as any).set) (clone as any).set('olcs_authHeaders', authFn);

    return clone;
  }


  private getAuthHeadersFn_():
    | ((ctx: {z?: number; x?: number; y?: number}) => Record<string, string>)
    | undefined {
    const s: any = this.source_;
    return s.get?.('olcs_authHeaders') ?? s.olcs_authHeaders;
  }

  private deriveTileWmsFromVector_(): TileWMS | null {
    try {
      const vt: any = this.source_;
      const proj = vt.getProjection?.() || this.projection_ || getProj('EPSG:3857');
      const grid = vt.getTileGrid?.()
        || vt.getTileGridForProjection?.(proj)
        || createXYZ({ extent: proj.getExtent(), tileSize: 256, maxZoom: 20 });

      const urlFn = vt.getTileUrlFunction?.();
      if (!urlFn) return null;

      // Probe one URL to recover base + params
      const sample = urlFn.call(vt, [0, 0, 0], 1, proj) as string;
      if (!sample) return null;

      const u = new URL(sample, (self as any).location?.href || undefined);
      const baseUrl = `${u.origin}${u.pathname}`;
      const parsed: Record<string, string> = {};
      u.searchParams.forEach((v, k) => (parsed[k.toUpperCase()] = v));

      const params = { ...parsed, ...(vt.params_ || {}), TILED: true };

      const src = new TileWMS({
        url: baseUrl,
        params,
        projection: proj,
        tileGrid: grid,
        crossOrigin: vt.get?.('crossOrigin') ?? 'anonymous',
        serverType: vt.serverType_ || vt.get?.('serverType') || 'geoserver',
        transition: 0
      });

      const olcs_proxy = vt.get?.('olcs_proxy') ?? vt.get?.('olcs.proxy');
      if (olcs_proxy) (src as any).set?.('olcs_proxy', olcs_proxy);

      const tlf = vt.getTileLoadFunction?.();
      if (tlf) (src as any).setTileLoadFunction(tlf);
      const authFn = this.getAuthHeadersFn_();
      if (authFn && (src as any).set) 
        (src as any).set('olcs_authHeaders', authFn);
      return src;
    } catch {
      return null;
    }
  }

  private tryInitOlWmsDelegate_() {
    // Only trigger if the app explicitly asked for WMS imagery in 3D
    const fmt: string | undefined = (this.source_ as any).get?.('olcs_wmsFormat');
    if (!fmt) return; // default: keep MVT→canvas path

    // Prefer a companion TileWMS if app stashed it; else derive from VT
    const companion: TileWMS | null =
      (this.source_ as any).get?.('olcs_wmsCompanion') ||
      (this.source_ as any).wmsCompanion ||
      null;

    const base = companion || this.deriveTileWmsFromVector_();
    if (!base) return;

    const overrides: Record<string, any> = { FORMAT: fmt, TILED: true };
    if (fmt !== 'image/jpeg') overrides.TRANSPARENT = true;

    const wmsFor3D = this.cloneTileWms_(base, overrides);

    // Build the stock OL → Cesium imagery bridge and adopt its tiling scheme
    this.olWmsDelegate_ = new OLImageryProvider(this.map_, wmsFor3D as any, this.fallbackProj_);
    this.tilingScheme_ = this.olWmsDelegate_.tilingScheme;
    this.rectangle_ = (this.olWmsDelegate_ as any).rectangle || this.rectangle_;
    this.ready_ = true;
  }
}
