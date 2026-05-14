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

    /**
     * Assigns nearest grass per compass sector from `this.allGrassyAreas`.
     * O(areas × vertices); dominates CPU once Overpass data is loaded.
     */
    _recomputeSectors(userLat, userLon) {
        this.sectors = Array(this.sectorCount).fill(null).map(() => ({ distance: Infinity }));
        this.isTouchingGrass = false;
        this.touchingAreaName = "";

        this.allGrassyAreas.forEach(area => {
            // Containment + nearest-point strategy, in order of precision:
            //   1. Closed polygon vertices (`out geom`) — exact.
            //   2. Axis-aligned bounding box (`out body bb`) — over-approximates containment,
            //      under-estimates distance, but still useful: "in the bbox of Central Park"
            //      is a much better signal than "X km from Central Park's centroid."
            //   3. Anchor point only (nodes, or a way with neither geom nor bounds) — distance
            //      to a single point; never reports containment.
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

            let nearest;
            if (hasPolygon) {
                nearest = getNearestPointOnGeometry(
                    userLat,
                    userLon,
                    area.geometry,
                    area.lat,
                    area.lon
                );
            } else if (hasBBox) {
                nearest = getNearestPointOnBBox(userLat, userLon, area.bounds);
            } else {
                nearest = getNearestPointOnGeometry(
                    userLat,
                    userLon,
                    null,
                    area.lat,
                    area.lon
                );
            }
            const dist = nearest.distanceKm;
            const bear = getBearing(userLat, userLon, nearest.lat, nearest.lon);
            const idx = Math.floor(((bear + (this.sectorAngle / 2)) % 360) / this.sectorAngle);

            if (dist < this.sectors[idx].distance) {
                this.sectors[idx] = {
                    ...area,
                    distance: dist,
                    targetLat: nearest.lat,
                    targetLon: nearest.lon
                };
            }
        });
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
