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

/**
 * Visits the per-edge closest-to-user point on a closed ring of (lat, lon) vertices.
 * Each edge contributes exactly one call to `visit(lat, lon, distanceKm)` — the foot of
 * the perpendicular from the user, clamped to the segment endpoints.
 *
 * This is the workhorse for two callers:
 *   1. Global-nearest queries (`getNearestPointOnGeometry` below) keep only the smallest.
 *   2. Per-sector compass scatter (in `NatureBrain._recomputeSectors`) bins each visit
 *      into a bearing sector so a polygon that angularly covers N sectors lights all N up,
 *      not just the one containing its global winner.
 *
 * No-op if `geometry` is falsy or empty.
 */
function forEachEdgeNearestPoint(userLat, userLon, geometry, visit) {
    if (!geometry || geometry.length === 0) return;
    const projected = geometry.map((p) => toLocalMeters(userLat, userLon, p.lat, p.lon));
    for (let i = 0; i < projected.length; i++) {
        const a = projected[i];
        const b = projected[(i + 1) % projected.length];
        const c = getClosestPointOnSegmentMeters(0, 0, a.x, a.y, b.x, b.y);
        const distKm = Math.sqrt(c.x * c.x + c.y * c.y) / 1000;
        const ll = toLatLon(userLat, userLon, c.x, c.y);
        visit(ll.lat, ll.lon, distKm);
    }
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
    let bestLat = null;
    let bestLon = null;
    let bestKm = Infinity;
    forEachEdgeNearestPoint(userLat, userLon, geometry, (lat, lon, distKm) => {
        if (distKm < bestKm) {
            bestKm = distKm;
            bestLat = lat;
            bestLon = lon;
        }
    });
    return { lat: bestLat, lon: bestLon, distanceKm: bestKm };
}

/**
 * Smallest clockwise 0–360° arc that contains every input bearing. Used to compute the
 * angular extent of a polygon as seen from the user, so we know which compass sectors
 * the polygon "occupies" — even ones where no per-edge closest point happened to land.
 *
 * Algorithm: sort bearings, find the largest gap between consecutive bearings (treating
 * 0/360 as a wrap-around boundary), and return the complement of that gap. Returns null
 * for empty input. For a single bearing, returns a zero-span arc at that bearing.
 */
function smallestEnclosingArc(bearings) {
    if (!bearings || bearings.length === 0) return null;
    if (bearings.length === 1) {
        return { start: bearings[0], end: bearings[0], spanDeg: 0 };
    }
    const sorted = [...bearings].sort((a, b) => a - b);
    let largestGap = -1;
    let arcStart = sorted[0];
    let arcEnd = sorted[sorted.length - 1];
    for (let i = 0; i < sorted.length - 1; i++) {
        const gap = sorted[i + 1] - sorted[i];
        if (gap > largestGap) {
            largestGap = gap;
            arcStart = sorted[i + 1];
            arcEnd = sorted[i];
        }
    }
    const wrapGap = 360 - sorted[sorted.length - 1] + sorted[0];
    if (wrapGap > largestGap) {
        largestGap = wrapGap;
        arcStart = sorted[0];
        arcEnd = sorted[sorted.length - 1];
    }
    return { start: arcStart, end: arcEnd, spanDeg: 360 - largestGap };
}

/** Tests whether `bearing` (0–360°) lies on the clockwise arc from arc.start to arc.end. */
function bearingInArc(bearing, arc) {
    if (!arc) return false;
    if (arc.spanDeg >= 360 - 1e-9) return true;
    const { start, end } = arc;
    if (start <= end) return bearing >= start && bearing <= end;
    return bearing >= start || bearing <= end;
}

/**
 * Coarse polygon stand-in for tier-1 (no-geometry) data: treat each park as its
 * axis-aligned lat/lon bounding box. Nearest point = clamp the user's lat/lon
 * into the rectangle; if the clamp doesn't move them, they're "inside."
 *
 * Trade-off vs `getNearestPointOnGeometry`:
 *   - Distance is a strict lower bound (bbox ⊇ polygon), so we never *over*-estimate.
 *   - Containment over-fires for non-rectangular parks (L-shaped, etc.). Acceptable
 *     during tier 1 because tier 2's polygon data overwrites within seconds.
 */
function getNearestPointOnBBox(userLat, userLon, bounds) {
    if (!bounds) return null;
    const lat = Math.max(bounds.minlat, Math.min(bounds.maxlat, userLat));
    const lon = Math.max(bounds.minlon, Math.min(bounds.maxlon, userLon));
    return {
        lat,
        lon,
        distanceKm: getDistance(userLat, userLon, lat, lon),
    };
}

function isPointInBBox(lat, lon, bounds) {
    if (!bounds) return false;
    return (
        lat >= bounds.minlat &&
        lat <= bounds.maxlat &&
        lon >= bounds.minlon &&
        lon <= bounds.maxlon
    );
}

function isPointInPolygon(lat, lon, geometry) {
    if (!geometry || geometry.length < 4) return false;

    // Only treat closed rings as polygons. Overpass geometry can include
    // open ways/paths, which should not trigger "touching grass" state.
    const first = geometry[0];
    const last = geometry[geometry.length - 1];
    const isClosedRing = Math.abs(first.lat - last.lat) < 1e-7 && Math.abs(first.lon - last.lon) < 1e-7;
    if (!isClosedRing) return false;

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
