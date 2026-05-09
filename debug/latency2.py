import requests
import time

# overpass-api.de returns 406 for the default python-requests User-Agent; identify this script.
HTTP_HEADERS = {
    "User-Agent": "touchGrass-latency2/1.0 (local benchmark; contact via repo maintainer)",
}

MIRRORS = {
    "Main (Germany)": "https://overpass-api.de/api/interpreter",
}

# Testing multiple areas (3 queries per mirror, per query type)
LOCATIONS = [
    ("Golden Gate Park", 37.7694, -122.4862),
    ("Central Park", 40.7812, -73.9665),
    ("Hyde Park", 51.5073, -0.1657),
]

QUERY_TEMPLATES = [
    ("TAGS ONLY", '[out:json][timeout:5];nwr["leisure"="park"](around:1000, {lat}, {lon});out tags center 20;'),
    ("FULL GEOM", '[out:json][timeout:5];nwr["leisure"="park"](around:1000, {lat}, {lon});out center 20;'),
]

def quick_bench():
    print("🚀 Starting Verbose Benchmark...")
    for name, url in MIRRORS.items():
        print(f"\nTesting Mirror: {name}")
        for loc_name, lat, lon in LOCATIONS:
            for q_label, q_template in QUERY_TEMPLATES:
                q_text = q_template.format(lat=lat, lon=lon)
                try:
                    print(f"  {loc_name} | {q_label}...", end=" ", flush=True)
                    start = time.perf_counter()
                    r = requests.post(
                        url,
                        headers=HTTP_HEADERS,
                        data={"data": q_text},
                        timeout=6,
                    )
                    latency = (time.perf_counter() - start) * 1000

                    if r.status_code == 200:
                        size = len(r.content) / 1024
                        print(f"Done! {latency:.0f}ms | {size:.1f} KB")
                    else:
                        print(f"Failed (Status {r.status_code})")
                except Exception:
                    print("Timed out or Error.")

if __name__ == "__main__":
    quick_bench()