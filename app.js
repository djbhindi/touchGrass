// 1. UI Elements
const locateBtn = document.getElementById('locate-me');
const statusText = document.getElementById('status');
const coordsText = document.getElementById('coords');
const compassDisk = document.getElementById('compass-disk');
const headingDisplay = document.getElementById('heading-display');
const distElement = document.getElementById('nearest-distance');
const nameElement = document.getElementById('nearest-name');

const brain = new NatureBrain(16);
let displayHeading = null;
let trackingStarted = false;
let geoWatchId = null;
let absoluteOrientationSeen = false;
let fallbackTimerId = null;

// 2. UI Render Function
function setBackgroundByDistance(distanceKm) {
    const maxDistanceKm = 2;
    const normalized = distanceKm === null ? 0 : Math.max(0, Math.min(1, 1 - (distanceKm / maxDistanceKm)));
    const curve = Math.pow(normalized, 0.6); // Boost contrast for closer distances
    const saturation = 18 + curve * 52; // 18% to 70%
    const lightness = 95 - curve * 20; // 95% to 75%
    document.body.style.backgroundColor = `hsl(120, ${saturation}%, ${lightness}%)`;
}

function updateUI(item, heading) {
    headingDisplay.innerText = `Heading: ${Math.round(heading)}°`;
    if (displayHeading === null) {
        displayHeading = heading;
    } else {
        const diff = ((heading - displayHeading + 540) % 360) - 180;
        displayHeading += diff;
    }
    compassDisk.style.transform = `rotate(${-displayHeading}deg)`;
    
    if (item && item.distance !== Infinity) {
        const d = item.distance < 1 ? `${(item.distance * 1000).toFixed(0)}m` : `${item.distance.toFixed(2)}km`;
        distElement.innerText = `${d} to Grass`;
        nameElement.innerText = item.name;
        setBackgroundByDistance(item.distance);
    } else {
        distElement.innerText = "Scanning for nature...";
        nameElement.innerText = "";
        setBackgroundByDistance(null);
    }
}

// 3. Execution / Event Listeners
document.addEventListener('DOMContentLoaded', () => {
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
        geoWatchId = navigator.geolocation.watchPosition((pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            coordsText.innerText = `Lat: ${latitude.toFixed(5)}, Lon: ${longitude.toFixed(5)} (±${accuracy.toFixed(1)}m)`;
            brain.updateUserPosition(latitude, longitude);
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
        const target = brain.getAreaInBearing(heading);
        updateUI(target, heading);
    }
}