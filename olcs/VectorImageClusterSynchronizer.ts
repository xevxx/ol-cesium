// src/olcs/VectorImageClusterSynchronizer.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import VectorImageLayer from 'ol/layer/VectorImage.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorSource from 'ol/source/Vector.js';
import Cluster from 'ol/source/Cluster.js';
import {getUid as olGetUid} from 'ol/util.js';

// IMPORTANT: relative import (we're inside the ol-cesium repo)
import BaseVectorSync from './VectorSynchronizer.js';

export default class VectorImageClusterSynchronizer extends BaseVectorSync {
  createSingleLayerCounterparts(olLayerWithParents: any) {
    const layer = olLayerWithParents.layer;

    // Only handle VectorImage; explicitly skip VectorTile.
    if (!(layer instanceof VectorImageLayer) || layer instanceof VectorTileLayer) return null;

    const src: any = layer.getSource?.();
    if (!(src instanceof Cluster)) return null; // clustered VectorImage only

    // ---- Optional per-layer mode flags ----
    // For clustered layers, this keeps behavior aligned with OL 2D:
    // recluster on zoom only; ignore pan mid-interaction.
    //   vectorImageLayer.set('olcsZoomOnlyAggregation', true)
    const ZOOM_ONLY_AGG = !!layer.get?.('olcsZoomOnlyAggregation');

    // Control what counts as a "zoom step" (default: integer zoom)
    //   vectorImageLayer.set('olcsZoomBucketSize', 1)    // integer
    //   vectorImageLayer.set('olcsZoomBucketSize', 0.5)  // half steps
    const zoomBucketSize: number = layer.get?.('olcsZoomBucketSize') ?? 1;

    // ---- ol-cesium internals ----
    const view: any = (this as any).view;
    const scene: any = (this as any).scene;
    const requestRender = () => { try { scene?.requestRender?.(); } catch {} };

    const featurePrimitiveMap: Record<string, any> = {};

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

    let lastZoomBucket: number | null = toBucket(getZoom());
    let lastLoadedBucket: number | null = null;      // last bucket we asked inner loader for
    let lastRebuildBucket: number | null = lastZoomBucket; // last bucket we rebuilt at
    let pendingZoomCheck = false;                    // set while camera is moving
    let isInteracting = false;                       // between moveStart and moveEnd

    const inner: VectorSource<any> | null = src.getSource() as VectorSource<any> | null;

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

    // Rebuild clustered features for the CURRENT resolution, from inner source’s current features
    const rebuildClustersNow = () => {
      const res = view?.getResolution ? view.getResolution() : undefined;
      (src as any).resolution = res; // private field used by Cluster internally

      try { src.clear(); } catch {}

      if (typeof (src as any).cluster === 'function') {
        (src as any).cluster();
        if (Array.isArray((src as any).features) && typeof src.addFeatures === 'function') {
          src.addFeatures((src as any).features); // emits addfeature per cluster feature
        }
      } else if (typeof (src as any).refresh === 'function') {
        (src as any).refresh();
      } else if (typeof src.changed === 'function') {
        src.changed();
      }
    };

    // Full rebuild (clear Cesium + recluster)
    const rebuildFromSource = () => {
      clearAll();
      rebuildClustersNow();
      lastRebuildBucket = toBucket(getZoom());
      (this as any).updateLayerVisibility(olLayerWithParents, csPrims);
      requestRender();
    };

    // Trigger the INNER VectorSource loader for the CURRENT view (extent/res/proj)
    const callInnerLoaderForCurrentView = (innerSrc: VectorSource<any>) => {
      const map = (this as any).map as import('ol/Map').default;
      const v = map.getView();
      const size = map.getSize();
      if (!size) return;
      const extent = v.calculateExtent(size);
      const res = v.getResolution();
      const proj = v.getProjection();

      if (typeof (innerSrc as any).loadFeatures === 'function') {
        (innerSrc as any).loadFeatures(extent, res, proj);
      } else {
        const loader = (innerSrc as any).loader_; // internal but common
        if (typeof loader === 'function') {
          loader(extent, res, proj);
        } else if (typeof (innerSrc as any).refresh === 'function') {
          (innerSrc as any).refresh();
        }
      }
    };

    // Bucketed loader trigger
    const callLoaderForCurrentViewBucketed = () => {
      if (!inner) return;
      const bucket = toBucket(getZoom());
      if (bucket === null || bucket === lastLoadedBucket) return;
      lastLoadedBucket = bucket;
      callInnerLoaderForCurrentView(inner);
      scheduleRecluster();
    };

    // Throttle recluster to one per frame
    let rafId: number | null = null;
    const scheduleRecluster = () => {
      if (rafId != null) return;
      rafId = (window as any).requestAnimationFrame(() => {
        rafId = null;
        rebuildFromSource();
      });
    };

    // ---------- listeners ---------------------------------------------------
    // Clustered source emits add/remove/change for cluster features.
    // Gate mid-pan updates if ZOOM_ONLY_AGG is set and zoom bucket hasn't changed.

    const gateMidPan = () =>
      ZOOM_ONLY_AGG && isInteracting && toBucket(getZoom()) === lastRebuildBucket;

    keys.push((src as any).on('addfeature',    (e: any) => { if (gateMidPan()) return; onAdd(e.feature); requestRender(); }));
    keys.push((src as any).on('removefeature', (e: any) => { if (gateMidPan()) return; onRemove(e.feature); requestRender(); }));
    keys.push((src as any).on('changefeature', (e: any) => { if (gateMidPan()) return; refreshFeature(e.feature); requestRender(); }));
    keys.push((src as any).on('clear', () => { if (gateMidPan()) return; clearAll(); requestRender(); }));

    // When the inner VectorSource loads new data, recluster and repopulate Cesium (gated mid-pan).
    if (inner) {
      keys.push((inner as any).on('featuresloadstart', () => {
        if (gateMidPan()) return;
        clearAll();
        requestRender();
      }));
      keys.push((inner as any).on('featuresloadend', () => {
        if (gateMidPan()) return;
        rebuildClustersNow();
        requestRender();
      }));
    }

    // If cluster params change, rebuild (user action; do not gate).
    keys.push((src as any).on?.('change:distance', () => scheduleRecluster()));
    keys.push((src as any).on?.('change:minDistance', () => scheduleRecluster()));

    // Style/declutter/opacity change → rebuild (do not gate; user intent).
    keys.push((layer as any).on('propertychange', (e: any) => {
      const k = e.key;
      if (k === 'style' || k === 'declutter' || k === 'opacity') {
        scheduleRecluster();
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
        if (!pendingZoomCheck) return; // pure pan (no res jitter) → ignore
        pendingZoomCheck = false;

        const cur = toBucket(getZoom());
        if (cur !== lastZoomBucket) {
          lastZoomBucket = cur;
          callLoaderForCurrentViewBucketed(); // inner loader + recluster (scheduled)
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

    // ✅ Initial seed
    if (inner) callInnerLoaderForCurrentView(inner); // load for current view
    rebuildFromSource();                               // draw whatever is available
    lastLoadedBucket = toBucket(getZoom());

    return [counterpart];
  }
}
