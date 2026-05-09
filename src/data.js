// Data fetcher for nearby grassy areas.
//
// Do NOT use `nwr[...]` with one `out`: it merges nodes + ways + relations — often hundreds of nodes.
//
// One Overpass POST, two reads:
//   1) ways + relations → MUST use `out geom` (not `out geom center`). On overpass-api.de,
//      `out geom center` omits the way-level `geometry` array and only emits `center`.
//   2) nodes → `out body`.
//
function flattenRelationOuterGeometry(rel) {
    if (!rel.members) return [];
    const pts = [];
    for (const m of rel.members) {
        if (m.role === "inner") continue;
        if (!m.geometry || !m.geometry.length) continue;
        for (const p of m.geometry) pts.push({ lat: p.lat, lon: p.lon });
    }
    return pts;
}

/** Normalized {lat,lon} rings for app geometry helpers (ways + multipolygon outers). */
function normalizedGeometryFromElement(el) {
    if (el.type === "relation") return flattenRelationOuterGeometry(el);
    const g = el.geometry;
    if (!g || !g.length) return [];
    return g.map((p) => ({ lat: p.lat, lon: p.lon }));
}

function anchorLatLon(el, geometryPts) {
    if (el.lat != null && el.lon != null) return { lat: el.lat, lon: el.lon };
    if (el.center) return { lat: el.center.lat, lon: el.center.lon };
    const b = el.bounds;
    if (b) {
        return {
            lat: (b.minlat + b.maxlat) / 2,
            lon: (b.minlon + b.maxlon) / 2,
        };
    }
    if (geometryPts.length) return { lat: geometryPts[0].lat, lon: geometryPts[0].lon };
    return { lat: NaN, lon: NaN };
}

async function fetchNearbyGrass(lat, lon, radius = 3000) {
    const url = "https://overpass-api.de/api/interpreter";
    const around = `around:${radius},${lat},${lon}`;
    const tagTriples = [
        ["leisure", "park"],
        ["landuse", "grass"],
        ["natural", "wood"],
    ];
    const sel = (type, k, v) => `${type}["${k}"="${v}"](${around});`;
    const wayRelSelectors = tagTriples
        .flatMap(([k, v]) => [sel("way", k, v), sel("relation", k, v)])
        .join("");
    const nodeSelectors = tagTriples.map(([k, v]) => sel("node", k, v)).join("");
    const query = `[out:json][timeout:25];(${wayRelSelectors});out geom;(${nodeSelectors});out body;`;
    const totalStart = performance.now();
    try {
        console.log(
            `[fetchNearbyGrass] ONE HTTP POST to Overpass (no parallel batch); radius=${radius}m`
        );
        const networkStart = performance.now();
        const response = await fetch(url, { method: "POST", body: query });
        const networkMs = performance.now() - networkStart;

        const bytes = Number(response.headers.get("content-length")) || null;
        const byteHint = bytes !== null ? `${bytes} bytes` : "chunked/unknown size";

        const jsonStart = performance.now();
        const data = await response.json();
        const jsonMs = performance.now() - jsonStart;

        const mapStart = performance.now();
        let nodes = 0;
        let ways = 0;
        let rels = 0;
        const mapped = data.elements.map(el => {
            if (el.type === "node") nodes++;
            else if (el.type === "way") ways++;
            else if (el.type === "relation") rels++;
            const geometry = normalizedGeometryFromElement(el);
            const { lat: la, lon: lo } = anchorLatLon(el, geometry);
            return {
                name: (el.tags && el.tags.name) || "Unnamed Grass",
                lat: la,
                lon: lo,
                geometry,
            };
        });
        const mapMs = performance.now() - mapStart;
        const totalMs = performance.now() - totalStart;

        const verts = mapped.reduce((n, a) => n + (a.geometry ? a.geometry.length : 0), 0);
        console.log(
            `[fetchNearbyGrass] HTTP ${response.status} ${response.ok ? "OK" : ""} | body≈${byteHint} | wait+download=${networkMs.toFixed(0)}ms | JSON.parse=${jsonMs.toFixed(0)}ms | map=${mapMs.toFixed(0)}ms | total=${totalMs.toFixed(0)}ms | ${mapped.length} areas (${nodes} nodes / ${ways} ways / ${rels} rels) | ${verts} geometry verts (ways + relation outers; nodes are points)`
        );
        return mapped;
    } catch (err) {
        const totalMs = performance.now() - totalStart;
        console.log(`[fetchNearbyGrass] failed after ${totalMs.toFixed(0)}ms`, err);
        return [];
    }
}
