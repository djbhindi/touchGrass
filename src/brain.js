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
            if (!this.isTouchingGrass && isPointInPolygon(userLat, userLon, area.geometry)) {
                this.isTouchingGrass = true;
                this.touchingAreaName = area.name;
            }

            const nearest = getNearestPointOnGeometry(
                userLat,
                userLon,
                area.geometry,
                area.lat,
                area.lon
            );
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
        statusText.innerText = isInitialFetch
            ? "Looking for grass..."
            : "You moved! Looking for new grass.";

        const wallStart = performance.now();
        const fetchGen = ++this._fetchGeneration;
        this._highestTierApplied = 0;
        console.log(
            `[NatureBrain] starting tiered fetch (gen ${fetchGen}) — move=${moveDist.toFixed(0)}m: tier 1 = 800m, tier 2 = 3000m, in parallel`
        );

        const runTier = async (tier, radiusM) => {
            const fetchStart = performance.now();
            const areas = await fetchNearbyGrass(lat, lon, radiusM);
            const fetchWallMs = performance.now() - fetchStart;

            const stale = fetchGen !== this._fetchGeneration;
            const skipEmptyTier1 = tier === 1 && areas.length === 0;
            const beatenByLargerTier = tier <= this._highestTierApplied;
            const apply = !stale && !skipEmptyTier1 && !beatenByLargerTier;

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

            const reason = stale
                ? "stale-generation"
                : skipEmptyTier1
                    ? "tier-1 empty, waiting for tier 2"
                    : beatenByLargerTier
                        ? "tier-2 already applied"
                        : "applied";
            console.log(
                `[NatureBrain] tier ${tier} (r=${radiusM}m) → ${areas.length} areas in ${fetchWallMs.toFixed(0)}ms (${reason})${apply ? `; sector=${sectorMsPostFetch.toFixed(1)}ms` : ""}`
            );

            window.dispatchEvent(
                new CustomEvent("touchgrass:grass-loaded", {
                    detail: {
                        tier,
                        radiusM,
                        fetchMs: fetchWallMs,
                        sectorMs: sectorMsPostFetch,
                        areas: areas.length,
                        applied: apply,
                    },
                })
            );
        };

        try {
            await Promise.all([runTier(1, 800), runTier(2, 3000)]);
        } finally {
            this.isFetching = false;
            statusText.innerText = "";
            console.log(
                `[NatureBrain] fetch pipeline total (both tiers) ${(performance.now() - wallStart).toFixed(0)}ms`
            );
        }
    }

    getAreaInBearing(userBearing) {
        const idx = Math.floor(((userBearing + (this.sectorAngle / 2)) % 360) / this.sectorAngle);
        return this.sectors[idx];
    }

    getTouchingState() {
        return {
            isTouchingGrass: this.isTouchingGrass,
            touchingAreaName: this.touchingAreaName
        };
    }
}
