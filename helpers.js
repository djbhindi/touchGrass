// Math helpers used across the app.
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getBearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.cos((lon2 - lon1) * Math.PI / 180);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function toLocalMeters(refLat, refLon, lat, lon) {
    const latScale = 111320;
    const lonScale = 111320 * Math.cos(refLat * Math.PI / 180);
    return {
        x: (lon - refLon) * lonScale,
        y: (lat - refLat) * latScale
    };
}

function toLatLon(refLat, refLon, x, y) {
    const latScale = 111320;
    const lonScale = 111320 * Math.cos(refLat * Math.PI / 180);
    return {
        lat: refLat + (y / latScale),
        lon: refLon + (x / lonScale)
    };
}

function getClosestPointOnSegmentMeters(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const abLenSq = (abx * abx) + (aby * aby);
    if (abLenSq === 0) return { x: ax, y: ay };

    let t = ((px - ax) * abx + (py - ay) * aby) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    return {
        x: ax + t * abx,
        y: ay + t * aby
    };
}

function getNearestPointOnGeometry(userLat, userLon, geometry, fallbackLat, fallbackLon) {
    if (!geometry || geometry.length === 0) {
        const lat = fallbackLat ?? userLat;
        const lon = fallbackLon ?? userLon;
        return {
            lat,
            lon,
            distanceKm: getDistance(userLat, userLon, lat, lon)
        };
    }

    const refLat = userLat;
    const refLon = userLon;
    const userPoint = { x: 0, y: 0 };

    const projected = geometry.map((p) => toLocalMeters(refLat, refLon, p.lat, p.lon));
    let best = null;
    let bestDistSq = Infinity;

    for (let i = 0; i < projected.length; i++) {
        const a = projected[i];
        const b = projected[(i + 1) % projected.length];
        const candidate = getClosestPointOnSegmentMeters(userPoint.x, userPoint.y, a.x, a.y, b.x, b.y);
        const dx = candidate.x - userPoint.x;
        const dy = candidate.y - userPoint.y;
        const distSq = (dx * dx) + (dy * dy);
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = candidate;
        }
    }

    const nearest = toLatLon(refLat, refLon, best.x, best.y);
    return {
        lat: nearest.lat,
        lon: nearest.lon,
        distanceKm: Math.sqrt(bestDistSq) / 1000
    };
}

function isPointInPolygon(lat, lon, geometry) {
    if (!geometry || geometry.length < 3) return false;

    let inside = false;
    for (let i = 0, j = geometry.length - 1; i < geometry.length; j = i++) {
        const xi = geometry[i].lon;
        const yi = geometry[i].lat;
        const xj = geometry[j].lon;
        const yj = geometry[j].lat;

        const intersects = ((yi > lat) !== (yj > lat)) &&
            (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);

        if (intersects) inside = !inside;
    }
    return inside;
}
