// Data fetcher for nearby grassy areas.
async function fetchNearbyGrass(lat, lon, radius = 5000) {
    const url = "https://overpass-api.de/api/interpreter";
    const query = `[out:json][timeout:25];(nwr["leisure"="park"](around:${radius},${lat},${lon});nwr["landuse"="grass"](around:${radius},${lat},${lon});nwr["natural"="wood"](around:${radius},${lat},${lon}););out geom center;`;
    try {
        const response = await fetch(url, { method: "POST", body: query });
        const data = await response.json();
        return data.elements.map(el => ({
            name: el.tags.name || "Unnamed Grass",
            lat: el.lat || el.center.lat,
            lon: el.lon || el.center.lon,
            geometry: (el.geometry || []).map((p) => ({ lat: p.lat, lon: p.lon }))
        }));
    } catch (err) {
        return [];
    }
}
