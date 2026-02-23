// Data fetcher for nearby grassy areas.
async function fetchNearbyGrass(lat, lon, radius = 5000) {
    const url = "https://overpass-api.de/api/interpreter";
    const query = `[out:json][timeout:25];(nwr["leisure"="park"](around:${radius},${lat},${lon});nwr["landuse"="grass"](around:${radius},${lat},${lon});nwr["natural"="wood"](around:${radius},${lat},${lon}););out geom center;`;
    const totalStart = performance.now();
    try {
        const networkStart = performance.now();
        const response = await fetch(url, { method: "POST", body: query });
        const networkMs = performance.now() - networkStart;

        const jsonStart = performance.now();
        const data = await response.json();
        const jsonMs = performance.now() - jsonStart;

        const mapStart = performance.now();
        const mapped = data.elements.map(el => ({
            name: el.tags.name || "Unnamed Grass",
            lat: el.lat || el.center.lat,
            lon: el.lon || el.center.lon,
            geometry: (el.geometry || []).map((p) => ({ lat: p.lat, lon: p.lon }))
        }));
        const mapMs = performance.now() - mapStart;
        const totalMs = performance.now() - totalStart;

        console.log(
            `[fetchNearbyGrass] ${mapped.length} areas | network=${networkMs.toFixed(0)}ms json=${jsonMs.toFixed(0)}ms map=${mapMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms`
        );
        return mapped;
    } catch (err) {
        const totalMs = performance.now() - totalStart;
        console.log(`[fetchNearbyGrass] failed after ${totalMs.toFixed(0)}ms`, err);
        return [];
    }
}
