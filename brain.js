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
        this.checkFetchThreshold(userLat, userLon);
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
        if (moveDist > 50) {
            this.isFetching = true;
            statusText.innerText = isInitialFetch
                ? "Looking for grass..."
                : "You moved! Looking for new grass.";
            this.allGrassyAreas = await fetchNearbyGrass(lat, lon);
            this.lastFetchLocation = { lat, lon };
            this.isFetching = false;
            statusText.innerText = "";
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
