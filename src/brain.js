// State + logic for mapping sensors to nearby nature.
class NatureBrain {
    constructor(sectorCount = 16) {
        this.sectorCount = sectorCount;
        this.sectorAngle = 360 / sectorCount;
        this.allGrassyAreas = [];
        this.lastFetchLocation = { lat: null, lon: null };
        this.isFetching = false;
        this.sectors = Array(sectorCount).fill(null).map(() => ({ distance: Infinity }));
        this.isTouchingGrass = false;
        this.touchingAreaName = "";

        // Smoothing properties
        this.currentHeading = 0;
        this.smoothingFactor = 0.15;

        /** Last GPS fix; used to rebuild sectors after async Overpass returns. */
        this._lastUserLat = null;
        this._lastUserLon = null;

        /**
         * Tiered fetch state:
         *  - Each fetch round bumps `_fetchGeneration`.
         *  - Within a round, only a strictly higher tier than `_highestTierApplied` may replace data,
         *    so a slow tier-1 landing after tier-2 doesn't downgrade results.
         */
        this._fetchGeneration = 0;
        this._highestTierApplied = 0;
    }

    processSensorData(event) {
        let rawHeading = 0;
        if (event.webkitCompassHeading) rawHeading = event.webkitCompassHeading;
        else if (event.alpha !== null) rawHeading = 360 - event.alpha;
        else return null;

        if (rawHeading === 0 && this.currentHeading > 1) return this.currentHeading;

        let diff = rawHeading - this.currentHeading;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;

        this.currentHeading = (this.currentHeading + diff * this.smoothingFactor + 360) % 360;
        return this.currentHeading;
    }

    updateUserPosition(userLat, userLon) {
        this._lastUserLat = userLat;
        this._lastUserLon = userLon;
        void this.checkFetchThreshold(userLat, userLon);
        const t0 = performance.now();
        this._recomputeSectors(userLat, userLon);
        const sectorMs = performance.now() - t0;
        if (this.allGrassyAreas.length > 0 && sectorMs > 40) {
            console.log(
                `[NatureBrain] sector pass (${this.allGrassyAreas.length} areas, GPS-driven) ${sectorMs.toFixed(1)}ms`
            );
        }
    }

    _sectorIndex(bearingDeg) {
        return Math.floor(((bearingDeg + (this.sectorAngle / 2)) % 360) / this.sectorAngle);
    }

    /**
     * Resolves "what grass is in each compass sector" in two passes:
     *
     *   Phase 1 — precise per-edge scatter. For each area we visit every edge's closest
     *     point to the user (`forEachEdgeNearestPoint`), bin that point's bearing into a
     *     sector, and keep the per-sector minimum across all edges and all areas. A polygon
     *     that angularly wraps around the user (e.g. a creek-side park hugging a
     *     residential pocket on three sides) lights up every sector it actually occupies
     *     with the *exact* per-bearing distance, instead of just the single sector that
     *     contains its global winner.
     *
     *   Phase 2 — interpolated bearing-range fill. For each area we compute the smallest arc
     *     enclosing its Phase-1 scatter bearings; any sector still at `Infinity` whose
     *     center falls inside some area's arc gets a distance *interpolated* between that
     *     area's nearest CW and CCW per-area hits, weighted by angular proximity. Tagged
     *     `approximate: true`. This is the same big-O as the precise pass (we already walk
     *     all sectors), but it tracks how the polygon's distance actually changes around
     *     the user — e.g. a creek-side park 80 m due south and 140 m to the southwest
     *     would fill the south-southwest sector with ~110 m, not the global-min 80 m.
     *
     *   Distance honesty: a Phase-2 fill is an interpolation between two true per-edge
     *     distances on this same polygon, so it never claims grass is closer than what the
     *     polygon's geometry actually permits within the two flanking sectors. The
     *     `approximate: true` flag is preserved on the sector object in case the UI wants
     *     to render it differently later (e.g. an italic distance, a "~" prefix).
     *
     * Cost: O(sum of vertices) for Phase 1 (same as the previous single-pass code), plus
     * O(V log V) per area for the arc sort, plus O(sectors² × areas) worst case for Phase 2
     * (per empty sector, per area, two short CW/CCW walks). With 16 sectors and ~50 areas
     * that's < 13 k ops — trivial compared to the edge-scatter pass.
     */
    _recomputeSectors(userLat, userLon) {
        this.sectors = Array(this.sectorCount).fill(null).map(() => ({ distance: Infinity }));
        this.isTouchingGrass = false;
        this.touchingAreaName = "";

        const perAreaInfo = [];

        this.allGrassyAreas.forEach((area) => {
            // Containment + scatter strategy, in order of precision:
            //   1. Closed polygon vertices (`out geom`) — exact `isPointInPolygon`.
            //   2. Axis-aligned bounding box (`out body bb`) — `isPointInBBox`; rectangle
            //      treated as a 4-vertex ring for scatter, so we still get up to 4 per-sector
            //      hits + bearing-range fill across the rest of the rectangle's angular span.
            //   3. Anchor point only (node feature) — single scatter point; never reports
            //      containment.
            const hasPolygon = area.geometry && area.geometry.length >= 4;
            const hasBBox = !!area.bounds;

            if (!this.isTouchingGrass) {
                if (hasPolygon && isPointInPolygon(userLat, userLon, area.geometry)) {
                    this.isTouchingGrass = true;
                    this.touchingAreaName = area.name;
                } else if (!hasPolygon && hasBBox && isPointInBBox(userLat, userLon, area.bounds)) {
                    this.isTouchingGrass = true;
                    this.touchingAreaName = area.name;
                }
            }

            const scatterBearings = [];
            // Per-area per-sector hits. Needed (instead of just the global per-sector min)
            // so Phase 2's CW/CCW walk only sees points from *this* polygon — interpolating
            // between two different parks' edges would be nonsense.
            const areaHits = new Map();

            const scatter = (lat2, lon2, dist) => {
                const bear = getBearing(userLat, userLon, lat2, lon2);
                scatterBearings.push(bear);
                const idx = this._sectorIndex(bear);
                if (dist < this.sectors[idx].distance) {
                    this.sectors[idx] = {
                        ...area,
                        distance: dist,
                        targetLat: lat2,
                        targetLon: lon2,
                        approximate: false,
                    };
                }
                const prev = areaHits.get(idx);
                if (!prev || dist < prev.dist) {
                    areaHits.set(idx, { dist, lat: lat2, lon: lon2 });
                }
            };

            if (hasPolygon) {
                forEachEdgeNearestPoint(userLat, userLon, area.geometry, scatter);
            } else if (hasBBox) {
                const b = area.bounds;
                const ring = [
                    { lat: b.minlat, lon: b.minlon },
                    { lat: b.minlat, lon: b.maxlon },
                    { lat: b.maxlat, lon: b.maxlon },
                    { lat: b.maxlat, lon: b.minlon },
                ];
                forEachEdgeNearestPoint(userLat, userLon, ring, scatter);
            } else {
                const dist = getDistance(userLat, userLon, area.lat, area.lon);
                scatter(area.lat, area.lon, dist);
            }

            perAreaInfo.push({
                area,
                arc: smallestEnclosingArc(scatterBearings),
                areaHits,
            });
        });

        // Phase 2: for each still-empty sector, find the area covering it whose nearest
        // CW/CCW per-area hits interpolate to the smallest distance. Both the CW and CCW
        // walks are guaranteed to find *some* hit (the arc was built from this area's
        // scatter, so at least one entry exists in areaHits); when only one is reachable
        // before wrapping the compass — i.e. the arc has hits on just one side of this
        // sector — we use that hit's distance unchanged rather than extrapolating.
        for (let idx = 0; idx < this.sectorCount; idx++) {
            if (this.sectors[idx].distance !== Infinity) continue;
            const sectorCenter = idx * this.sectorAngle;
            let best = null;
            for (const info of perAreaInfo) {
                if (!info.arc) continue;
                if (!bearingInArc(sectorCenter, info.arc)) continue;
                if (info.areaHits.size === 0) continue;

                // Walk CW and CCW from the empty sector to find this area's nearest flanking
                // per-sector hits. Each walk bails out the moment it would step past the arc
                // boundary, so we never reach across the back of the compass for a "wrap-around"
                // hit that is geometrically the other arc endpoint. When only one side yields
                // a hit, the fallback below uses that single hit's distance unchanged.
                let ccwIdx = null;
                let ccwStep = 0;
                for (let step = 1; step < this.sectorCount; step++) {
                    const i = (idx - step + this.sectorCount) % this.sectorCount;
                    if (!bearingInArc(i * this.sectorAngle, info.arc)) break;
                    if (info.areaHits.has(i)) {
                        ccwIdx = i;
                        ccwStep = step;
                        break;
                    }
                }
                let cwIdx = null;
                let cwStep = 0;
                for (let step = 1; step < this.sectorCount; step++) {
                    const i = (idx + step) % this.sectorCount;
                    if (!bearingInArc(i * this.sectorAngle, info.arc)) break;
                    if (info.areaHits.has(i)) {
                        cwIdx = i;
                        cwStep = step;
                        break;
                    }
                }

                let dist;
                let lat;
                let lon;
                if (ccwIdx !== null && cwIdx !== null && ccwIdx !== cwIdx) {
                    // Inverse-step weights: the *closer* neighbor gets the *larger* weight,
                    // so a sector 1 step CCW and 3 steps CW pulls 75 % toward the CCW value.
                    const ccwHit = info.areaHits.get(ccwIdx);
                    const cwHit = info.areaHits.get(cwIdx);
                    const total = ccwStep + cwStep;
                    const wCCW = cwStep / total;
                    const wCW = ccwStep / total;
                    dist = ccwHit.dist * wCCW + cwHit.dist * wCW;
                    lat = ccwHit.lat * wCCW + cwHit.lat * wCW;
                    lon = ccwHit.lon * wCCW + cwHit.lon * wCW;
                } else {
                    const onlyHit = info.areaHits.get(ccwIdx !== null ? ccwIdx : cwIdx);
                    dist = onlyHit.dist;
                    lat = onlyHit.lat;
                    lon = onlyHit.lon;
                }

                if (!best || dist < best.dist) {
                    best = { area: info.area, dist, lat, lon };
                }
            }
            if (best) {
                this.sectors[idx] = {
                    ...best.area,
                    distance: best.dist,
                    targetLat: best.lat,
                    targetLon: best.lon,
                    approximate: true,
                };
            }
        }
    }

    async checkFetchThreshold(lat, lon) {
        if (this.isFetching) return;
        const isInitialFetch = this.lastFetchLocation.lat === null;
        const moveDist = this.lastFetchLocation.lat
            ? getDistance(lat, lon, this.lastFetchLocation.lat, this.lastFetchLocation.lon) * 1000
            : Infinity;
        if (moveDist <= 50) return;

        this.isFetching = true;
        this.lastFetchLocation = { lat, lon };

        // Tier 1 (bbox-only, 800 m) is purely a first-paint accelerator. Once we have any
        // polygon-quality area on screen, the user's "nearest grass" display is already
        // accurate, so subsequent moves silently re-fetch only tier 2 and keep the previous
        // polygons live in `allGrassyAreas` until tier 2 lands and atomically swaps them.
        const haveGeomData = this.allGrassyAreas.some(
            (a) => a.geometry && a.geometry.length > 0
        );
        const runFirstPaintTier = !haveGeomData;

        statusText.innerText = isInitialFetch
            ? "Looking for grass..."
            : "You moved! Looking for new grass.";

        const wallStart = performance.now();
        const fetchGen = ++this._fetchGeneration;
        this._highestTierApplied = 0;
        console.log(
            `[NatureBrain] starting tiered fetch (gen ${fetchGen}) — move=${moveDist.toFixed(0)}m: ${runFirstPaintTier ? "tier 1 = 800m (bbox) + tier 2 = 3000m (geom)" : "tier 2 = 3000m (geom) only; keeping existing polygons live until it lands"}`
        );

        const runTier = async (tier, radiusM, fetchOpts) => {
            const fetchStart = performance.now();
            let areas = null;
            let fetchError = null;
            try {
                areas = await fetchNearbyGrass(lat, lon, radiusM, fetchOpts);
            } catch (err) {
                fetchError = err;
            }
            const fetchWallMs = performance.now() - fetchStart;

            const stale = fetchGen !== this._fetchGeneration;
            const failed = fetchError !== null;
            const skipEmptyTier1 = tier === 1 && !failed && areas.length === 0;
            const beatenByLargerTier = tier <= this._highestTierApplied;
            const apply = !failed && !stale && !skipEmptyTier1 && !beatenByLargerTier;

            let sectorMsPostFetch = 0;
            if (apply) {
                this._highestTierApplied = tier;
                this.allGrassyAreas = areas;
                if (this._lastUserLat !== null && this._lastUserLon !== null) {
                    const tSector = performance.now();
                    this._recomputeSectors(this._lastUserLat, this._lastUserLon);
                    sectorMsPostFetch = performance.now() - tSector;
                }
            }

            const reason = failed
                ? "fetch-failed (keeping previous data)"
                : stale
                    ? "stale-generation"
                    : skipEmptyTier1
                        ? "tier-1 empty, waiting for tier 2"
                        : beatenByLargerTier
                            ? "tier-2 already applied"
                            : "applied";
            const areasCount = failed ? 0 : areas.length;
            console.log(
                `[NatureBrain] tier ${tier} (r=${radiusM}m) → ${areasCount} areas in ${fetchWallMs.toFixed(0)}ms (${reason})${apply ? `; sector=${sectorMsPostFetch.toFixed(1)}ms` : ""}`
            );

            window.dispatchEvent(
                new CustomEvent("touchgrass:grass-loaded", {
                    detail: {
                        tier,
                        radiusM,
                        fetchMs: fetchWallMs,
                        sectorMs: sectorMsPostFetch,
                        areas: areasCount,
                        applied: apply,
                        failed,
                    },
                })
            );
        };

        try {
            // Tier 1 (bbox, 800 m) only runs when there is nothing precise to display yet.
            //   Each park is approximated by its lat/lon rectangle; edge distance is a strict
            //   lower bound on the true distance (bbox ⊇ polygon), and we still flag
            //   "touching grass" via point-in-rectangle. Over-fires on L-shaped parks, but
            //   tier 2 corrects that within seconds.
            // Tier 2 (geom, 3000 m) always runs: it owns final accuracy. On re-fetches the
            //   previous polygons stay live in `allGrassyAreas` until tier 2 lands, so the UI
            //   never blinks back to "scanning" or empty distance while the user is walking.
            const tiers = [];
            if (runFirstPaintTier) {
                tiers.push(runTier(1, 800, { geometryMode: "bbox", serverTimeoutSec: 8 }));
            }
            tiers.push(runTier(2, 3000, { geometryMode: "geom", serverTimeoutSec: 25 }));
            await Promise.all(tiers);
        } finally {
            this.isFetching = false;
            statusText.innerText = "";
            console.log(
                `[NatureBrain] fetch pipeline total ${(performance.now() - wallStart).toFixed(0)}ms`
            );
        }
    }

    getAreaInBearing(userBearing) {
        const idx = Math.floor(((userBearing + (this.sectorAngle / 2)) % 360) / this.sectorAngle);
        return this.sectors[idx];
    }

    /**
     * Closest grass across all sectors, or null when no data has loaded yet.
     * Used as a fallback when the sector the user is facing happens to be empty,
     * so the UI can show a real distance instead of "Scanning for nature..." forever.
     */
    getNearestArea() {
        let best = null;
        for (const s of this.sectors) {
            if (s.distance === Infinity) continue;
            if (!best || s.distance < best.distance) best = s;
        }
        return best;
    }

    hasData() {
        return this.allGrassyAreas.length > 0;
    }

    getTouchingState() {
        return {
            isTouchingGrass: this.isTouchingGrass,
            touchingAreaName: this.touchingAreaName
        };
    }
}
