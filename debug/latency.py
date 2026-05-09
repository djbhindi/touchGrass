import requests
import time
import statistics

# overpass-api.de returns 406 for the default python-requests User-Agent.
HTTP_HEADERS = {
    "User-Agent": "touchGrass-latency/1.0 (local benchmark; contact via repo maintainer)",
}

MIRRORS = {
    "Main (Germany)": "https://overpass-api.de/api/interpreter",
    "French Mirror": "https://overpass.openstreetmap.fr/api/interpreter",
    "Kumi Systems (Global)": "https://overpass.kumi.systems/api/interpreter"
}

# Queries for SF (Golden Gate Park area)
QUERIES = {
    "out center": """
        [out:json][timeout:10];
        (
          nwr["leisure"="park"](around:2000, 37.7694, -122.4862);
        );
        out center;
    """,
    "out tags center": """
        [out:json][timeout:10];
        (
          nwr["leisure"="park"](around:2000, 37.7694, -122.4862);
        );
        out tags center;
    """
}

def benchmark():
    results = {name: {q: {"l": [], "s": []} for q in QUERIES} for name in MIRRORS}
    
    print("🚀 Benchmarking Payload Size vs Latency (3 Rounds)...")
    for r in range(3):
        for m_name, m_url in MIRRORS.items():
            for q_name, q_text in QUERIES.items():
                try:
                    start = time.perf_counter()
                    resp = requests.post(
                        m_url,
                        headers=HTTP_HEADERS,
                        data={"data": q_text},
                        timeout=15,
                    )
                    latency = (time.perf_counter() - start) * 1000
                    if resp.status_code == 200:
                        results[m_name][q_name]["l"].append(latency)
                        results[m_name][q_name]["s"].append(len(resp.content) / 1024)
                except: pass

    print(f"\n{'Mirror':<22} | {'Variant':<16} | {'Avg Latency':<12} | {'Avg Size'}")
    print("-" * 70)
    for m, vairs in results.items():
        for q, mtr in vairs.items():
            if mtr["l"]:
                print(f"{m:<22} | {q:<16} | {statistics.mean(mtr['l']):8.2f}ms | {statistics.mean(mtr['s']):7.1f} KB")

if __name__ == "__main__":
    benchmark()