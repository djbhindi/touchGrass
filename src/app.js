// 1. UI Elements
const locateBtn = document.getElementById('locate-me');
const statusText = document.getElementById('status');
const compassDisk = document.getElementById('compass-disk');
const headingDisplay = document.getElementById('heading-display');
const distElement = document.getElementById('nearest-distance');
const nameElement = document.getElementById('nearest-name');
const touchingBanner = document.getElementById('touching-grass-banner');
const debugTimingBar = document.getElementById('debug-timing-bar');

function touchGrassDebugEnabled() {
    try {
        return (
            new URLSearchParams(location.search).has("debug") ||
            localStorage.getItem("touchgrassDebug") === "1"
        );
    } catch {
        return new URLSearchParams(location.search).has("debug");
    }
}

const DEBUG_UI = touchGrassDebugEnabled();

function updateDebugTimingBar(metrics) {
    if (!DEBUG_UI || !metrics) return;
    const set = (id, val) => {
        if (val == null) return;
        const el = document.getElementById(id);
        if (el) el.textContent = `${Math.round(val)}`;
    };
    set("debug-boot-ms", metrics.bootMs);
    set("debug-geo-wait-ms", metrics.watchToFirstGeoMs);
    if (metrics.tier === 1) set("debug-fetch-1-ms", metrics.fetchMs);
    if (metrics.tier === 2) set("debug-fetch-2-ms", metrics.fetchMs);
    if (metrics.applied) {
        set("debug-sector-ms", metrics.sectorMs);
        set("debug-nav-grass-ms", metrics.navToGrassReadyMs);
        if (metrics.areas != null) {
            const a = document.getElementById("debug-areas-count");
            if (a) a.textContent = String(metrics.areas);
        }
    }
    if (metrics.firstGeoAccuracyM != null) {
        const acc = document.getElementById("debug-geo-acc");
        if (acc) acc.textContent = `${Math.round(metrics.firstGeoAccuracyM)} m`;
    }
}

/** Stage 1: ms from navigation start until we registered watchPosition. */
let msBoot = null;
/** Stage 2: ms from watchPosition() until first callback (GPS subsystem). */
let msWatchToFirstGeo = null;
/** Horizontal accuracy (m) reported on first fix. */
let firstGeoAccuracyM = null;
/** performance.now() when watchPosition was registered. */
let perfWhenGeoWatchStarted = null;

const brain = new NatureBrain(16);
let displayHeading = null;
/** Set when DeviceOrientation yields a real compass heading; if still null, we assume north (0°). */
let compassHeadingDeg = null;
let trackingStarted = false;
let geoWatchId = null;
let absoluteOrientationSeen = false;
let fallbackTimerId = null;
let hasLocation = false;

function refreshMainUI() {
    const heading = compassHeadingDeg !== null ? compassHeadingDeg : 0;
    let target = brain.getAreaInBearing(heading);
    let outOfBearing = false;
    if (!target || target.distance === Infinity) {
        const fallback = brain.getNearestArea();
        if (fallback) {
            target = fallback;
            outOfBearing = true;
        }
    }
    updateUI(target, heading, brain.getTouchingState(), {
        outOfBearing,
        dataLoaded: brain.hasData(),
    });
}

// 2. UI Render Function
function setBackgroundByDistance(distanceKm) {
    const maxDistanceKm = 2;
    const normalized = distanceKm === null ? 0 : Math.max(0, Math.min(1, 1 - (distanceKm / maxDistanceKm)));
    const curve = Math.pow(normalized, 0.6); // Boost contrast for closer distances
    const saturation = 18 + curve * 52; // 18% to 70%
    const lightness = 95 - curve * 20; // 95% to 75%
    document.body.style.backgroundColor = `hsl(120, ${saturation}%, ${lightness}%)`;
}

function updateUI(item, heading, touchingState, opts = {}) {
    const { outOfBearing = false, dataLoaded = false } = opts;
    // Use HTML entity so display is correct even if document/script charset is wrong (avoids "Â°").
    headingDisplay.innerHTML = `${Math.round(heading)}&#176;`;
    if (displayHeading === null) {
        displayHeading = heading;
    } else {
        const diff = ((heading - displayHeading + 540) % 360) - 180;
        displayHeading += diff;
    }
    compassDisk.style.transform = `rotate(${-displayHeading}deg)`;

    if (item && item.distance !== Infinity) {
        const d = item.distance < 1 ? `${(item.distance * 1000).toFixed(0)}m` : `${item.distance.toFixed(2)}km`;
        distElement.innerText = outOfBearing ? `${d} to Grass — turn to face it` : `${d} to Grass`;
        nameElement.innerText = item.name;
        setBackgroundByDistance(item.distance);
    } else {
        // Once we have any data at all, "scanning" is a lie — we genuinely found nothing nearby.
        distElement.innerText = dataLoaded ? "No grass found nearby." : "Scanning for nature...";
        nameElement.innerText = "";
        setBackgroundByDistance(null);
    }

    if (touchingState.isTouchingGrass) {
        touchingBanner.classList.add('visible');
        document.body.classList.add('touching-grass');
        distElement.innerText = "You're touching grass";
        nameElement.innerText = touchingState.touchingAreaName || "";
        setBackgroundByDistance(0);
    } else {
        touchingBanner.classList.remove('visible');
        document.body.classList.remove('touching-grass');
    }
}

// 3. Execution / Event Listeners
window.addEventListener("touchgrass:grass-loaded", (ev) => {
    const d = ev.detail || {};
    const navToGrassReadyMs = performance.now();
    console.log(
        `[app] grass-loaded tier=${d.tier} radius=${d.radiusM}m fetch=${Math.round(d.fetchMs ?? 0)}ms applied=${d.applied} areas=${d.areas}`
    );
    if (DEBUG_UI) {
        updateDebugTimingBar({
            ...d,
            navToGrassReadyMs,
            bootMs: msBoot,
            watchToFirstGeoMs: msWatchToFirstGeo,
            firstGeoAccuracyM,
        });
    }
    if (d.applied) refreshMainUI();
});

document.addEventListener('DOMContentLoaded', () => {
    if (DEBUG_UI && debugTimingBar) {
        document.body.classList.add("debug-mode");
        debugTimingBar.hidden = false;
    }
    statusText.innerText = "Waiting for location...";
    startTracking(false);
});

locateBtn.addEventListener('click', async () => {
    await startTracking(true);
});

async function startTracking(fromUserGesture) {
    if (trackingStarted && !fromUserGesture) return;
    if (trackingStarted && fromUserGesture) {
        locateBtn.style.display = 'none';
        return;
    }
    trackingStarted = true;

    // Start Orientation (iOS requires this inside a user gesture)
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        if (fromUserGesture) {
            const response = await DeviceOrientationEvent.requestPermission();
            if (response === 'granted') {
                window.addEventListener('deviceorientation', handleOrientationEvent);
                locateBtn.style.display = 'none';
            } else {
                statusText.innerText = "Compass permission denied.";
                trackingStarted = false;
            }
        } else {
            statusText.innerText = "Tap 'Start Tracking' to enable compass.";
            locateBtn.style.display = '';
            trackingStarted = false;
        }
    } else {
        window.addEventListener('deviceorientationabsolute', handleOrientationEvent, true);
        fallbackTimerId = window.setTimeout(() => {
            if (!absoluteOrientationSeen) {
                window.addEventListener('deviceorientation', handleOrientationEvent, true);
            }
        }, 1000);
        locateBtn.style.display = 'none';
    }

    // Start Geolocation (auto-start)
    if (geoWatchId === null) {
        perfWhenGeoWatchStarted = performance.now();
        msBoot = perfWhenGeoWatchStarted;
        if (DEBUG_UI) updateDebugTimingBar({ bootMs: msBoot });
        geoWatchId = navigator.geolocation.watchPosition((pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            const geoT0 = performance.now();
            if (msWatchToFirstGeo == null && perfWhenGeoWatchStarted != null) {
                msWatchToFirstGeo = geoT0 - perfWhenGeoWatchStarted;
                firstGeoAccuracyM = accuracy;
                if (DEBUG_UI) {
                    updateDebugTimingBar({
                        watchToFirstGeoMs: msWatchToFirstGeo,
                        firstGeoAccuracyM,
                    });
                }
            }
            if (!hasLocation) {
                hasLocation = true;
                if (statusText.innerText === "Waiting for location...") {
                    statusText.innerText = "";
                }
            }
            brain.updateUserPosition(latitude, longitude);
            refreshMainUI();
            const geoMs = performance.now() - geoT0;
            if (geoMs > 25) {
                console.log(`[app] watchPosition handler (brain + UI) ${geoMs.toFixed(1)}ms`);
            }
        }, (err) => { statusText.innerText = `GPS Error: ${err.message}`; }, { enableHighAccuracy: true });
    }
}

function handleOrientationEvent(event) {
    if (event.type === 'deviceorientationabsolute' || event.absolute === true) {
        absoluteOrientationSeen = true;
        if (fallbackTimerId !== null) {
            window.clearTimeout(fallbackTimerId);
            fallbackTimerId = null;
        }
    } else if (absoluteOrientationSeen && event.type === 'deviceorientation') {
        return;
    }
    const heading = brain.processSensorData(event);
    if (heading !== null) {
        compassHeadingDeg = heading;
        refreshMainUI();
    }
}