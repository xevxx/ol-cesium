/* eslint-disable @typescript-eslint/no-explicit-any */

import HeatmapLayer from 'ol/layer/Heatmap.js';
import VectorSource from 'ol/source/Vector.js';
import {transform as olTransform} from 'ol/proj.js';
import AbstractSynchronizer from './AbstractSynchronizer.js';

type LayerWithParents = { layer: any; parents: any[] };
type Kernel = { canvas: HTMLCanvasElement; footprint: number };

// --- tiny 2×2 matrix helpers for the follow-transform -----------------------
function inv2x2(
  a11: number, a12: number, a21: number, a22: number
): [number, number, number, number] | null {
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-8) return null;
  const invDet = 1 / det;
  // return a mutable tuple (no `as const`)
  return [ a22 * invDet, -a12 * invDet, -a21 * invDet, a11 * invDet ];
}
function mul2x2(
  A: Readonly<[number, number, number, number]>,
  B: Readonly<[number, number, number, number]>
): [number, number, number, number] {
  const [a11, a12, a21, a22] = A;
  const [b11, b12, b21, b22] = B;
  return [
    a11*b11 + a12*b21,
    a11*b12 + a12*b22,
    a21*b11 + a22*b21,
    a21*b12 + a22*b22,
  ];
}

export default class HeatmapSynchronizer extends AbstractSynchronizer<any> {
  private overlayCanvas: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private overlayAttached = false;

  private rafId: number | null = null;
  private redrawQueued = false;

  private cesiumMoveEndUnlisten: (() => void) | null = null;
  private cesiumMoveStartUnlisten: (() => void) | null = null;
  private postRenderUnlisten: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private paletteCache = new Map<string, number[][]>();
  private kernelCache = new Map<string, Kernel>();

  // anchors captured at the last full render
  private anchorLonLat: [number, number] | null = null;
  private anchorLonLatX: [number, number] | null = null;
  private anchorLonLatY: [number, number] | null = null;
  private anchorScreenC: { x: number; y: number } | null = null;
  private anchorScreenX: { x: number; y: number } | null = null;
  private anchorScreenY: { x: number; y: number } | null = null;

  constructor(map: any, scene: any, _dsc?: any) {
    super(map, scene);
  }

  // We manage a DOM overlay, not Cesium primitives.
  addCesiumObject(_obj: any) {}
  destroyCesiumObject(_obj: any) { this.cleanupOverlay(); }
  removeSingleCesiumObject(_c: any, _destroy: boolean) { this.cleanupOverlay(); }
  removeAllCesiumObjects(_destroy: boolean) { this.cleanupOverlay(); }

  createSingleLayerCounterparts(olLayerWithParents: LayerWithParents) {
    const layer = olLayerWithParents.layer;
    if (!(layer instanceof HeatmapLayer)) return null;

    const src: any = layer.getSource?.();
    if (!(src instanceof VectorSource)) return null;

    const scene: any = (this as any).scene;
    const map: any = (this as any).map;
    const view: any = (this as any).view;
    const Cesium: any = (window as any).Cesium;

    const keys: any[] = [];
    const counterpart = {
      olListenKeys: keys,
      getRootPrimitive: () => ({ show: !!layer.getVisible?.() }),
      destroy: () => this.cleanupOverlay(),
      context: {},
    };

    const requestRender = () => { try { scene?.requestRender?.(); } catch {} };

    // ---------- overlay attach / detach ----------
    const ensureOverlay = () => {
      if (this.overlayAttached) return;
      const host = scene?.canvas?.parentElement || scene?.canvas;
      if (!host) return;

      const cvs = document.createElement('canvas');
      cvs.style.position = 'absolute';
      cvs.style.left = '0';
      cvs.style.top = '0';
      cvs.style.pointerEvents = 'none';
      cvs.style.zIndex = '1';
      cvs.style.transformOrigin = '0 0';
      host.appendChild(cvs);

      this.overlayCanvas = cvs;
      this.overlayCtx = cvs.getContext('2d')!;
      this.overlayAttached = true;

      const ro = new ResizeObserver(() => resizeToHost());
      ro.observe(host);
      this.resizeObserver = ro;
      resizeToHost();
    };

    const removeOverlayNode = () => {
      if (!this.overlayAttached) return;
      const cvs = this.overlayCanvas!;
      try { cvs.remove(); } catch {}
      this.overlayCanvas = null;
      this.overlayCtx = null;
      this.overlayAttached = false;
      if (this.resizeObserver) { try { this.resizeObserver.disconnect(); } catch {} ; this.resizeObserver = null; }
    };

    const resizeToHost = () => {
      if (!this.overlayAttached) return;
      const host = scene?.canvas?.parentElement || scene?.canvas;
      const cvs = this.overlayCanvas!;
      if (!host || !cvs) return;

      const cssW = host.clientWidth || 0;
      const cssH = host.clientHeight || 0;
      const dpr = (window.devicePixelRatio || 1);

      cvs.style.width = cssW + 'px';
      cvs.style.height = cssH + 'px';
      const needW = Math.max(1, Math.round(cssW * dpr));
      const needH = Math.max(1, Math.round(cssH * dpr));
      if (cvs.width !== needW || cvs.height !== needH) {
        cvs.width = needW;
        cvs.height = needH;
        const ctx = this.overlayCtx!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
      }
    };

    // ---------- palette / kernel ----------
    const makePalette = (gradient: string[]) => {
      const key = gradient.join('|');
      const cached = this.paletteCache.get(key);
      if (cached) return cached;

      const g = document.createElement('canvas');
      g.width = 1; g.height = 256;
      const gctx = g.getContext('2d')!;
      const grd = gctx.createLinearGradient(0, 0, 0, 256);
      const n = Math.max(2, gradient.length);
      gradient.forEach((c, i) => grd.addColorStop(i / (n - 1), c));
      gctx.fillStyle = grd; gctx.fillRect(0, 0, 1, 256);

      const data = gctx.getImageData(0, 0, 1, 256).data;
      const palette: number[][] = new Array(256);
      for (let i = 0; i < 256; i++) {
        const off = i * 4;
        palette[i] = [data[off], data[off + 1], data[off + 2], data[off + 3]];
      }
      this.paletteCache.set(key, palette);
      return palette;
    };

    const makeKernel = (radius: number, blur: number, scale: number): Kernel => {
      const r0 = Math.max(1, radius) * scale;
      const bl = Math.max(0, blur) * scale;
      const outer = r0 + bl;
      const size = Math.max(1, (Math.ceil(outer) * 2 + 1));

      const key = `${Math.round(r0)}-${Math.round(bl)}`;
      const hit = this.kernelCache.get(key);
      if (hit) return hit;

      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d')!;
      const cx = Math.ceil(outer);
      const cy = cx;

      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
      const plateau = outer > 0 ? Math.min(1, Math.max(0, r0 / outer)) : 1;
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(Math.max(0, Math.min(1, plateau)), 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);

      const kernel = { canvas: c, footprint: Math.ceil(outer) };
      this.kernelCache.set(key, kernel);
      return kernel;
    };

    // ---------- alpha scaling ----------
    const effectiveArea = (r: number, b: number) => r*r + r*b + 0.5*b*b;
    const alphaFromRadiusBlur = (
      r: number,
      b: number,
      base = { r0: 8, b0: 15, alpha0: 0.65 },
      clamp = { min: 0.05, max: 1.0 }
    ) => {
      const A0 = effectiveArea(base.r0, base.b0);
      const A  = effectiveArea(r, b);
      const raw = base.alpha0 * (A0 / Math.max(1e-6, A));
      return Math.max(clamp.min, Math.min(clamp.max, raw));
    };

    // ---------- capture anchors for follow-transform ----------
    const captureAnchors = () => {
      const canvas = scene?.canvas as HTMLCanvasElement;
      if (!canvas) return false;
      const cxCss = canvas.clientWidth / 2;
      const cyCss = canvas.clientHeight / 2;

      const cart = scene.camera.pickEllipsoid(new Cesium.Cartesian2(cxCss, cyCss), scene.globe.ellipsoid);
      if (!cart) return false;
      const carto = Cesium.Cartographic.fromCartesian(cart);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);

      const dLon = 0.0005;
      const dLat = 0.0005;

      const toWin = (lo: number, la: number) => {
        const w = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
          scene, Cesium.Cartesian3.fromDegrees(lo, la, 0)
        );
        return w ? { x: w.x, y: w.y } : null;
      };

      const pC = toWin(lon, lat);
      const pX = toWin(lon + dLon, lat);
      const pY = toWin(lon, lat + dLat);
      if (!pC || !pX || !pY) return false;

      this.anchorLonLat  = [lon, lat];
      this.anchorLonLatX = [lon + dLon, lat];
      this.anchorLonLatY = [lon, lat + dLat];
      this.anchorScreenC = pC;
      this.anchorScreenX = pX;
      this.anchorScreenY = pY;

      if (this.overlayCanvas) this.overlayCanvas.style.transform = '';
      return true;
    };

    // ---------- compute & apply CSS follow-transform ----------
    const applyFollowTransform = () => {
      if (!this.overlayCanvas || !this.anchorLonLat || !this.anchorScreenC) return;

      const toWin = (lo: number, la: number) => {
        const w = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
          scene, Cesium.Cartesian3.fromDegrees(lo, la, 0)
        );
        return w ? { x: w.x, y: w.y } : null;
      };

      const c0 = this.anchorScreenC;
      const x0 = this.anchorScreenX!;
      const y0 = this.anchorScreenY!;
      const [lonC, latC] = this.anchorLonLat;
      const [lonX, latX] = this.anchorLonLatX!;
      const [lonY, latY] = this.anchorLonLatY!;

      const c1 = toWin(lonC, latC);
      const x1 = toWin(lonX, latX);
      const y1 = toWin(lonY, latY);
      if (!c1 || !x1 || !y1) return;

      const ex0 = { x: x0.x - c0.x, y: x0.y - c0.y };
      const ey0 = { x: y0.x - c0.x, y: y0.y - c0.y };
      const ex1 = { x: x1.x - c1.x, y: x1.y - c1.y };
      const ey1 = { x: y1.x - c1.x, y: y1.y - c1.y };

      const B  = [ ex0.x, ey0.x, ex0.y, ey0.y ] as [number, number, number, number];
      const Bi = inv2x2(B[0], B[1], B[2], B[3]);
      if (!Bi) return;

      const T = [ ex1.x, ey1.x, ex1.y, ey1.y ] as [number, number, number, number];
      const A = mul2x2(T, Bi);

      const tx = c1.x - (A[0] * c0.x + A[1] * c0.y);
      const ty = c1.y - (A[2] * c0.x + A[3] * c0.y);

      const a = A[0], b = A[2], c = A[1], d = A[3], e = tx, f = ty;
      this.overlayCanvas.style.transform = `matrix(${a},${b},${c},${d},${e},${f})`;
    };

    // ---------- full render (expensive) ----------
    const renderHeatmapOverlay = () => {
      ensureOverlay();
      if (!this.overlayAttached) return;

      const cvs = this.overlayCanvas!;
      const ctx = this.overlayCtx!;
      const cssW = cvs.clientWidth;
      const cssH = cvs.clientHeight;

      const maxDim = 1024;
      const scale = Math.min(1, maxDim / Math.max(cssW, cssH));
      const w = Math.max(1, Math.round(cssW * scale));
      const h = Math.max(1, Math.round(cssH * scale));

      const acc = document.createElement('canvas'); acc.width = w; acc.height = h;
      const accCtx = acc.getContext('2d')!;
      accCtx.clearRect(0, 0, w, h);
      accCtx.globalCompositeOperation = 'source-over';

      const out = document.createElement('canvas'); out.width = w; out.height = h;
      const outCtx = out.getContext('2d')!;
      outCtx.clearRect(0, 0, w, h);

      const radius = Number(layer.getRadius?.() ?? 8);
      const blur = Number(layer.getBlur?.() ?? 15);
      const gradient: string[] = layer.getGradient?.() || [
        'rgba(0,0,255,0)', '#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000'
      ];
      const palette = makePalette(gradient);
      const { canvas: kernel, footprint } = makeKernel(radius, blur, scale);

      const feats: any[] = src.getFeatures ? src.getFeatures() : [];
      const weightAttr = (layer as any).getWeight?.() || 'weight';
      const proj = view.getProjection();

      const alphaScale = alphaFromRadiusBlur(radius, blur, { r0: radius, b0: blur, alpha0: 0.60 });

      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        const geom = f.getGeometry?.();
        if (!geom) continue;

        // Collect projected points
        const points: Array<[number, number]> = [];
        const type = geom.getType?.();
        if (type === 'Point') {
          points.push(geom.getCoordinates());
        } else if (type === 'MultiPoint') {
          const cs = geom.getCoordinates() || [];
          for (let j = 0; j < cs.length; j++) points.push(cs[j]);
        } else {
          const coords = geom.getCoordinates?.();
          const walk = (x: any) => {
            if (Array.isArray(x) && typeof x[0] === 'number' && typeof x[1] === 'number') {
              points.push(x as [number, number]);
              return;
            }
            if (Array.isArray(x)) for (let k = 0; k < x.length; k++) walk(x[k]);
          };
          walk(coords);
        }

        let weight = 1;
        const wv = f.get ? f.get(weightAttr) : undefined;
        if (typeof wv === 'number') weight = Math.max(0, wv);
        else if (wv != null) { const num = Number(wv); if (!Number.isNaN(num)) weight = Math.max(0, num); }
        if (!(weight > 0)) continue;

        accCtx.globalAlpha = Math.min(1, Math.max(0, weight * alphaScale));

        for (let k = 0; k < points.length; k++) {
          const cXY = points[k];
          const lonlat = olTransform(cXY, proj, 'EPSG:4326'); // [lon, lat]

          const cart = Cesium.Cartesian3.fromDegrees(lonlat[0], lonlat[1], 0.0);
          const win = Cesium.SceneTransforms.wgs84ToWindowCoordinates(scene, cart);
          if (!win) continue;

          const x = Math.round(win.x * scale);
          const y = Math.round(win.y * scale);
          if (x < -footprint || y < -footprint || x > w + footprint || y > h + footprint) continue;

          accCtx.drawImage(kernel, x - footprint, y - footprint);
        }
      }

      // colorize
      const id = accCtx.getImageData(0, 0, w, h);
      const srcData = id.data;
      const outImg = outCtx.createImageData(w, h);
      const dst = outImg.data;

      const gain  = 1.0;
      const gamma = 0.92;
      const minAlpha = 64;

      for (let p = 0; p < srcData.length; p += 4) {
        const a = srcData[p + 3];
        if (a === 0) continue;

        const tRaw = Math.min(1, (a / 255) * gain);
        const t    = Math.pow(tRaw, gamma);
        const idx  = (t * 255) | 0;

        const col = palette[idx] || [0, 0, 0, 0];
        dst[p]     = col[0];
        dst[p + 1] = col[1];
        dst[p + 2] = col[2];
        dst[p + 3] = Math.min(255, Math.max(minAlpha, Math.round(col[3] * t)));
      }
      outCtx.putImageData(outImg, 0, 0);

      // paint to overlay (CSS pixels)
      const ctxCssW = cvs.clientWidth, ctxCssH = cvs.clientHeight;
      this.overlayCanvas!.style.transform = ''; // reset baseline
      ctx.clearRect(0, 0, ctxCssW, ctxCssH);
      ctx.globalAlpha = Math.max(0, Math.min(1, Number(layer.getOpacity?.() ?? 1)));
      ctx.drawImage(out, 0, 0, ctxCssW, ctxCssH);

      // capture anchors for the follow-transform baseline
      captureAnchors();
    };

    const scheduleRedraw = () => {
      ensureOverlay();
      if (!this.overlayAttached) return;
      if (this.redrawQueued) return;
      this.redrawQueued = true;
      this.rafId = (window as any).requestAnimationFrame(() => {
        this.redrawQueued = false;
        renderHeatmapOverlay();
      });
    };

    // initial paint
    scheduleRedraw();

    // ---- layer/source events ----
    keys.push(src.on('addfeature',    () => scheduleRedraw()));
    keys.push(src.on('removefeature', () => scheduleRedraw()));
    keys.push(src.on('changefeature', () => scheduleRedraw()));
    keys.push(src.on('clear',         () => scheduleRedraw()));

    keys.push(layer.on('propertychange', (e: any) => {
      const k = e.key;
      if (k === 'radius' || k === 'blur' || k === 'gradient' || k === 'opacity') {
        scheduleRedraw();
      } else if (k === 'visible') {
        if (this.overlayCanvas) {
          const visible = !!layer.getVisible?.();
          this.overlayCanvas.style.display = visible ? '' : 'none';
        }
        try { scene?.requestRender?.(); } catch {}
      }
    }));

    [layer, ...olLayerWithParents.parents].forEach((l: any) => {
      keys.push(l.on('change:visible', () => {
        if (this.overlayCanvas) {
          const allVisible = [layer, ...olLayerWithParents.parents].every((p: any) => !!p.getVisible?.());
          this.overlayCanvas.style.display = allVisible ? '' : 'none';
        }
        try { scene?.requestRender?.(); } catch {}
      }));
    });

    // ---- follow camera during interaction; repaint on moveEnd ----
    const cam = scene?.camera;

    if (cam?.moveStart) {
      const onStart = () => {
        if (!this.anchorScreenC) captureAnchors(); // baseline if missing
        if (!this.postRenderUnlisten) {
          const fn = () => { applyFollowTransform(); };
          scene.postRender.addEventListener(fn);
          this.postRenderUnlisten = () => { try { scene.postRender.removeEventListener(fn); } catch {} };
        }
      };
      cam.moveStart.addEventListener(onStart);
      this.cesiumMoveStartUnlisten = () => { try { cam.moveStart.removeEventListener(onStart); } catch {} };
    }

    if (cam?.moveEnd) {
      const onEnd = () => {
        if (this.postRenderUnlisten) { this.postRenderUnlisten(); this.postRenderUnlisten = null; }
        if (this.overlayCanvas) this.overlayCanvas.style.transform = '';
        scheduleRedraw(); // recompute for final view
      };
      cam.moveEnd.addEventListener(onEnd);
      this.cesiumMoveEndUnlisten = () => { try { cam.moveEnd.removeEventListener(onEnd); } catch {} };
    } else {
      // fallback if Cesium events unavailable
      keys.push(view.on('change:center',     () => scheduleRedraw()));
      keys.push(view.on('change:resolution', () => scheduleRedraw()));
    }

    return [counterpart];
  }

  // Clean up overlay + listeners
  private cleanupOverlay() {
    if (this.rafId != null) {
      try { (window as any).cancelAnimationFrame(this.rafId); } catch {}
      this.rafId = null;
      this.redrawQueued = false;
    }
    if (this.postRenderUnlisten) { this.postRenderUnlisten(); this.postRenderUnlisten = null; }
    if (this.cesiumMoveEndUnlisten) { this.cesiumMoveEndUnlisten(); this.cesiumMoveEndUnlisten = null; }
    if (this.cesiumMoveStartUnlisten) { this.cesiumMoveStartUnlisten(); this.cesiumMoveStartUnlisten = null; }
    if (this.overlayCanvas) this.overlayCanvas.style.transform = '';
    if (this.overlayAttached) {
      try { this.overlayCanvas?.remove(); } catch {}
      this.overlayAttached = false;
    }
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch {}
      this.resizeObserver = null;
    }
    this.overlayCanvas = null;
    this.overlayCtx = null;
    this.anchorLonLat = this.anchorLonLatX = this.anchorLonLatY = null;
    this.anchorScreenC = this.anchorScreenX = this.anchorScreenY = null;
  }
}
