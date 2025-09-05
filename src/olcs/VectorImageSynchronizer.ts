// src/olcs/VectorImageSynchronizer.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import VectorImageLayer from 'ol/layer/VectorImage.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorSource from 'ol/source/Vector.js';
import Cluster from 'ol/source/Cluster.js';
import {getUid as olGetUid} from 'ol/util.js';

// IMPORTANT: relative import (we're inside the ol-cesium repo)
import BaseVectorSync from './VectorSynchronizer.js';

export default class VectorImageSynchronizer extends BaseVectorSync {
  createSingleLayerCounterparts(olLayerWithParents: any) {
    const layer = olLayerWithParents.layer;

    // Only handle VectorImage; explicitly skip VectorTile.
    if (!(layer instanceof VectorImageLayer) || layer instanceof VectorTileLayer) return null;

    const src: any = layer.getSource?.();
    // Clustered VectorImage is handled by VectorImageClusterSynchronizer
    if (src instanceof Cluster) return null;
    if (!(src instanceof VectorSource)) return null;

    // ---- Optional per-layer mode flags ----
    // Set on hexbin-like layers so aggregation only recomputes on zoom, not pan:
    //   vi.set('olcsZoomOnlyAggregation', true)
    const ZOOM_ONLY_AGG = !!layer.get?.('olcsZoomOnlyAggregation');

    // Optional: control what counts as a "zoom step" (default: integer zoom)
    //   vi.set('olcsZoomBucketSize', 1)   // integer
    //   vi.set('olcsZoomBucketSize', 0.5) // half steps, etc.
    const zoomBucketSize: number = layer.get?.('olcsZoomBucketSize') ?? 1;

    // ---- ol-cesium internals ----
    const view: any = (this as any).view;
    const scene: any = (this as any).scene;
    const requestRender = () => { try { scene?.requestRender?.(); } catch {} };

    const featurePrimitiveMap: Record<string, any> = {};

    // Build Cesium counterpart via the stock converter (works with VectorImageLayer).
    const counterpart: any = (this as any).converter.olVectorLayerToCesium(
      layer as any,
      view,
      featurePrimitiveMap
    );
    if (!counterpart) return null;

    const csPrims: any = counterpart.getRootPrimitive();
    const keys: any[] = counterpart.olListenKeys;

    // Keep Cesium visibility in sync with OL parents.
    [olLayerWithParents.layer, ...olLayerWithParents.parents].forEach((l: any) => {
      keys.push((l as any).on('change:visible', () => {
        (this as any).updateLayerVisibility(olLayerWithParents, csPrims);
        requestRender();
      }));
    });
    (this as any).updateLayerVisibility(olLayerWithParents, csPrims);

    // ---------- helpers / state -----------------------------------------------------

    const getZoom = () => view?.getZoom?.();
    const toBucket = (z: number | undefined | null) =>
      z == null ? null : Math.round(z / zoomBucketSize);

    // Track buckets & interaction state
    let lastZoomBucket: number | null = toBucket(getZoom());
    let lastLoadedBucket: number | null = null;      // last bucket we asked the loader for
    let lastRebuildBucket: number | null = lastZoomBucket; // last bucket we rebuilt primitives at
    let pendingZoomCheck = false;                    // set while camera is moving
    let isInteracting = false;                       // between moveStart and moveEnd

    const removeCesiumForFeature = (featureId: string) => {
      const ctx = counterpart.context || {};
      const f2c = ctx.featureToCesiumMap || {};
      const arr: any[] = f2c[featureId] || [];
      delete f2c[featureId];

      const tryRemove = (item: any) => {
        try { ctx.billboards?.remove?.(item); } catch {}
        try { ctx.billboardCollection?.remove?.(item); } catch {}
        try { ctx.labels?.remove?.(item); } catch {}
        try { ctx.labelCollection?.remove?.(item); } catch {}
        try { ctx.polylines?.remove?.(item); } catch {}
        try { ctx.groundPrimitives?.remove?.(item); } catch {}
        try { ctx.primitives?.remove?.(item); } catch {}
        try { csPrims?.remove?.(item); } catch {}
      };
      for (const it of arr) tryRemove(it);

      const prim = featurePrimitiveMap[featureId];
      delete featurePrimitiveMap[featureId];
      if (prim) { try { csPrims.remove(prim); } catch {} }
    };

    const onAdd = (feature: any) => {
      const prim = (this as any).converter.convert(layer as any, view, feature, counterpart.context);
      if (prim) {
        featurePrimitiveMap[olGetUid(feature)] = prim;
        csPrims.add(prim);
      }
    };

    const onRemove = (feature: any) => {
      removeCesiumForFeature(olGetUid(feature));
    };

    const refreshFeature = (feature: any) => {
      onRemove(feature);
      onAdd(feature);
    };

    const clearAll = () => {
      for (const id of Object.keys(featurePrimitiveMap)) {
        const prim = featurePrimitiveMap[id];
        delete featurePrimitiveMap[id];
        if (prim) { try { csPrims.remove(prim); } catch {} }
      }
      const ctx = counterpart.context || {};
      if (ctx.featureToCesiumMap) {
        for (const id of Object.keys(ctx.featureToCesiumMap)) delete ctx.featureToCesiumMap[id];
      }
      const maybeCollections = [
        'billboards', 'billboardCollection',
        'labels', 'labelCollection',
        'polylines', 'groundPrimitives', 'primitives'
      ];
      for (const name of maybeCollections) {
        try { ctx[name]?.removeAll?.(); } catch {}
      }
    };

    // Rebuild primitives from current source features (init + zoom/style changes)
    const rebuildFromSource = () => {
      clearAll();
      const feats = src.getFeatures ? src.getFeatures() : [];
      for (const f of feats) onAdd(f);
      lastRebuildBucket = toBucket(getZoom());
      (this as any).updateLayerVisibility(olLayerWithParents, csPrims);
      requestRender();
    };

    // Trigger the VectorSource loader for the CURRENT view (extent/res/proj)
    const callLoaderForCurrentView = (vsrc: VectorSource<any>) => {
      const map = (this as any).map as import('ol/Map').default;
      const v = map.getView();
      const size = map.getSize();
      if (!size) return;
      const extent = v.calculateExtent(size);
      const res = v.getResolution();
      const proj = v.getProjection();

      if (typeof (vsrc as any).loadFeatures === 'function') {
        (vsrc as any).loadFeatures(extent, res, proj);
      } else {
        const loader = (vsrc as any).loader_; // internal but common
        if (typeof loader === 'function') {
          loader(extent, res, proj);
        } else if (typeof (vsrc as any).refresh === 'function') {
          (vsrc as any).refresh();
        }
      }
    };

    // Only call loader & rebuild when the zoom "bucket" changes
    const callLoaderForCurrentViewBucketed = () => {
      const bucket = toBucket(getZoom());
      if (bucket === null || bucket === lastLoadedBucket) return;
      lastLoadedBucket = bucket;
      callLoaderForCurrentView(src);
      scheduleRebuild();
    };

    // Throttle rebuilds to one per frame (prevents flicker/overwork)
    let rafId: number | null = null;
    const scheduleRebuild = () => {
      if (rafId != null) return;
      rafId = (window as any).requestAnimationFrame(() => {
        rafId = null;
        rebuildFromSource();
      });
    };

    // ---------- listeners ---------------------------------------------------

    // Source feature changes — gate mid-pan updates for zoom-only aggregation
    keys.push((src as any).on('addfeature', (e: any) => {
      if (ZOOM_ONLY_AGG && isInteracting && toBucket(getZoom()) === lastRebuildBucket) return;
      onAdd(e.feature);
      requestRender();
    }));
    keys.push((src as any).on('removefeature', (e: any) => {
      if (ZOOM_ONLY_AGG && isInteracting && toBucket(getZoom()) === lastRebuildBucket) return;
      onRemove(e.feature);
      requestRender();
    }));
    keys.push((src as any).on('changefeature', (e: any) => {
      if (ZOOM_ONLY_AGG && isInteracting && toBucket(getZoom()) === lastRebuildBucket) return;
      refreshFeature(e.feature);
      requestRender();
    }));
    keys.push((src as any).on('clear', () => {
      if (ZOOM_ONLY_AGG && isInteracting && toBucket(getZoom()) === lastRebuildBucket) return;
      clearAll();
      requestRender();
    }));

    // If the source uses a loader, handle load cycles — also gated mid-pan for zoom-only aggregations.
    keys.push((src as any).on?.('featuresloadstart', () => {
      if (ZOOM_ONLY_AGG && isInteracting && toBucket(getZoom()) === lastRebuildBucket) return;
      clearAll();
      requestRender();
    }));
    keys.push((src as any).on?.('featuresloadend', () => {
      if (ZOOM_ONLY_AGG && isInteracting && toBucket(getZoom()) === lastRebuildBucket) return;
      rebuildFromSource();
    }));

    // Style/declutter/opacity change → rebuild primitives so they pick up new style.
    keys.push((layer as any).on('propertychange', (e: any) => {
      const k = e.key;
      if (k === 'style' || k === 'declutter' || k === 'opacity') {
        scheduleRebuild();
      } else if (k === 'visible') {
        (this as any).updateLayerVisibility(olLayerWithParents, csPrims);
        requestRender();
      }
    }));

    // change:resolution jitters during pan — just mark, we’ll confirm at moveEnd.
    keys.push(view.on('change:resolution', () => {
      pendingZoomCheck = true;
    }));

    // Cesium camera interaction gate: ignore mid-pan updates; act at moveEnd if bucket changed.
    const cam = (this as any).scene?.camera;
    if (cam?.moveStart && cam?.moveEnd) {
      const onMoveStart = () => { isInteracting = true; };
      const onMoveEnd = () => {
        isInteracting = false;
        if (!pendingZoomCheck) return;          // pure pan with no res jitter → ignore
        pendingZoomCheck = false;

        const cur = toBucket(getZoom());
        if (cur !== lastZoomBucket) {
          lastZoomBucket = cur;
          callLoaderForCurrentViewBucketed();   // loader + rebuild if bucket changed
        }
        // If bucket did NOT change, we intentionally do nothing (zoom-only aggregation)
      };

      cam.moveStart.addEventListener(onMoveStart);
      cam.moveEnd.addEventListener(onMoveEnd);

      // tidy removal when counterpart is destroyed
      const origDestroy = counterpart.destroy?.bind(counterpart);
      counterpart.destroy = () => {
        try { cam.moveStart.removeEventListener(onMoveStart); } catch {}
        try { cam.moveEnd.removeEventListener(onMoveEnd); } catch {}
        if (rafId != null) {
          try { (window as any).cancelAnimationFrame(rafId); } catch {}
          rafId = null;
        }
        origDestroy?.();
      };
    } else {
      // Fallback if no Cesium camera (unlikely): bucket directly on resolution changes.
      keys.push(view.on('change:resolution', () => callLoaderForCurrentViewBucketed()));
    }

    // Initial paint + initial load (record the bucket we loaded at)
    rebuildFromSource();
    callLoaderForCurrentView(src);
    lastLoadedBucket = toBucket(getZoom());

    return [counterpart];
  }
}
