import http from 'http';
import fs from 'fs';
import path from 'path';

const SETTINGS_PATH = path.join(import.meta.dirname, 'settings.json');

const DEFAULT_SETTINGS = {
    mishpachasWord: 'משפחת',
    familyName: '',
    zip: '11367',
    havdalahMinutes: 60,
    photoFilename: 'sample-family-photo.png',
    photoUpdatedAt: null,
};

function loadSettings() {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings(newSettings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(newSettings, null, 2));
}

let settings = loadSettings();

// Returns today's date as YYYY-MM-DD using the server's LOCAL timezone,
// rather than Date.toISOString() (which is always UTC). UTC runs 4-5 hours
// ahead of Eastern time, so using toISOString() would roll over to
// "tomorrow" every evening well before midnight actually arrives locally —
// causing daf yomi, zmanim, and hebrew date lookups to silently request the
// wrong day for that window each night.
function getLocalDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

let cachedStatic = null;   // parasha, dafYomi, hebrewDate, zmanim, location, shabbosTimes
let cachedWeather = null;

// Fetches JSON with a timeout and a couple of automatic retries, so a brief
// network blip doesn't surface as a failed refresh — most transient errors
// resolve themselves within a second or two.
async function fetchAPI(url, options = {}, retries = 2) {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);

            if (!res.ok) {
                throw new Error(`Request failed (${res.status}): ${url}`);
            }
            return await res.json();
        } catch (err) {
            const isLastAttempt = attempt === retries + 1;
            if (isLastAttempt) throw err;

            console.warn(`[${new Date().toISOString()}] Fetch attempt ${attempt} failed for ${url}, retrying:`, err.message);
            await new Promise(r => setTimeout(r, 1000 * attempt)); // 1s, 2s backoff
        }
    }
}

// Looks ahead week by week (up to maxWeeksAhead) to find the next Shabbos
// with a regular parasha reading, for use when the current week has none
// (e.g. a Yom Tov falling on Shabbos, like Sukkos). Returns that future
// week's parasha, candle lighting, and havdalah items together — so the
// whole Shabbos box stays internally consistent and describes one single
// week — or null if nothing is found within the search window.
async function findUpcomingParashaWeek(fromDate, maxWeeksAhead = 4) {
    for (let i = 1; i <= maxWeeksAhead; i++) {
        const future = new Date(fromDate);
        future.setDate(future.getDate() + 7 * i);
        const gy = future.getFullYear();
        const gm = future.getMonth() + 1; // Hebcal expects 1-12
        const gd = future.getDate();

        try {
            const data = await fetchAPI(
                `https://www.hebcal.com/shabbat?cfg=json&zip=${settings.zip}&m=${settings.havdalahMinutes}&leyning=off&lg=a&gy=${gy}&gm=${gm}&gd=${gd}`
            );
            const parashatItem = data.items.find((item) => item.category === "parashat");
            if (parashatItem) {
                return {
                    parashatItem,
                    candleLightingObject: data.items.find((item) => item.category === "candles"),
                    havdalahObject: data.items.find((item) => item.category === "havdalah"),
                };
            }
        } catch (err) {
            console.warn(`[${new Date().toISOString()}] Failed to check upcoming parasha (week +${i}):`, err.message);
        }
    }

    console.warn(`[${new Date().toISOString()}] No upcoming parasha found within ${maxWeeksAhead} weeks`);
    return null;
}

// ── Static-for-the-day data (parasha, daf yomi, hebrew date, zmanim, shabbos times) ──
// Refetched once every 24h (see scheduleStaticRefresh). On failure, cachedStatic is
// intentionally left untouched so the display keeps showing the last known-good data
// rather than breaking.
async function refreshStaticData() {
    try {
        const today = getLocalDateString();

        // Daf Yomi — via Hebcal's dedicated endpoint. Including just F=on restricts results to just the daf yomi item.
        const dafYomiData = await fetchAPI(`https://www.hebcal.com/hebcal?cfg=json&v=1&F=on&start=${today}&end=${today}&lg=a`);
        const dafYomiItem = dafYomiData.items.find((item) => item.category === "dafyomi");

        let dafYomiObject = null;
        if (dafYomiItem) {
            const heWithoutDaf = dafYomiItem.hebrew.replace(/\s*דף\s*/, ' ').trim();
            dafYomiObject = { displayValue: { he: heWithoutDaf, en: dafYomiItem.title } };
        } else {
            console.warn(`[${new Date().toISOString()}] Daf Yomi not found in Hebcal response for ${today}`);
        }

        const converterData = await fetchAPI(`https://www.hebcal.com/converter?cfg=json&date=${today}&g2h=1&strict=1`);
        const hebrewDateObject = converterData.hebrew;

        const zmanimData = await fetchAPI(`https://www.hebcal.com/zmanim?cfg=json&zip=${settings.zip}&date=${today}`);
        const zmanimObject = zmanimData.times;
        const location = {
            city: zmanimData.location.city,
            state: zmanimData.location.stateName,
            latitude: zmanimData.location.latitude,
            longitude: zmanimData.location.longitude,
        };

        const zmanimMap = [
            {key: "alotHaShachar", he: "עלות השחר", en: "Alos HaShachar"},
            {key: "misheyakir", he: "משיכיר", en: "Misheyakir"},
            {key: "sunrise", he: "הנץ החמה", en: "Netz HaChama"},
            {key: "sofZmanShmaMGA", he: 'ס"ז ק"ש מג"א', en: 'Sof Zman Shma MG"A'},
            {key: "sofZmanShma", he: 'ס"ז ק"ש גר"א', en: 'Sof Zman Shma GR"A'},
            {key: "sofZmanTfilla", he: 'ס"ז תפלה גר"א', en: "Sof Zman Tefillah"},
            {key: "chatzot", he: "חצות", en: "Chatzos HaYom"},
            {key: "minchaGedola", he: "מנחה גדולה", en: "Mincha Gedola"},
            {key: "minchaKetana", he: "מנחה קטנה", en: "Mincha Ketana"},
            {key: "plagHaMincha", he: 'פלג המנחה גר"א', en: 'Plag HaMincha GR"A'},
            {key: "sunset", he: "שקיעה", en: "Shkiah"},
            {key: "tzeit50min", he: "צאת הכוכבים", en: "Tzeis HaKochavim (50 min)"},
        ];

        const zmanim = zmanimMap
            .filter((item) => zmanimObject[item.key])
            .map((item) => {
                const date = new Date(zmanimObject[item.key]);
                const time12 = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                return { he: item.he, en: item.en, time: time12 };
            });

        const shabbatData = await fetchAPI(`https://www.hebcal.com/shabbat?cfg=json&zip=${settings.zip}&m=${settings.havdalahMinutes}&leyning=off&lg=a`);

        // Parasha, candle lighting, and havdalah are all pulled from the same
        // response so the whole Shabbos box always describes one consistent
        // week. On a week where a Yom Tov falls on Shabbos and there is no
        // regular parasha reading (e.g. Sukkos), look ahead to the next
        // Shabbos that does have one, and use THAT week's candle
        // lighting/havdalah too — rather than mixing next week's parasha
        // with this week's (holiday) times.
        let parashaObject, candleLightingObject, havdalahObject;

        const parashatItem = shabbatData.items.find((item) => item.category === "parashat");

        if (parashatItem) {
            parashaObject = { he: parashatItem.hebrew };
            candleLightingObject = shabbatData.items.find((item) => item.category === "candles");
            havdalahObject = shabbatData.items.find((item) => item.category === "havdalah");
        } else {
            const upcoming = await findUpcomingParashaWeek(new Date());
            if (upcoming) {
                parashaObject = { he: upcoming.parashatItem.hebrew };
                candleLightingObject = upcoming.candleLightingObject;
                havdalahObject = upcoming.havdalahObject;
            } else {
                // Nothing found within the search window — fall back to this
                // week's own times (e.g. Sukkos candle lighting) so the
                // display isn't left completely blank, even though there's
                // no parasha to show.
                parashaObject = null;
                candleLightingObject = shabbatData.items.find((item) => item.category === "candles");
                havdalahObject = shabbatData.items.find((item) => item.category === "havdalah");
            }
        }

        cachedStatic = {
            parashaObject, dafYomiObject, hebrewDateObject, zmanim, location,
            shabbosTimes: { candleLightingObject, havdalahObject }
        };

        console.log(`[${new Date().toISOString()}] Static data refreshed`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Static data refresh failed, keeping last known data:`, err.message);
    }
}

// ── Weather (changes intraday) ── refetched every 15 min. On failure, cachedWeather
// is left untouched for the same reason as above.
async function refreshWeather() {
    if (!cachedStatic) return; // needs lat/lng from static data first

    try {
        const { latitude, longitude } = cachedStatic.location;

        const data = await fetchAPI(
            `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
            `&current=temperature_2m,apparent_temperature,weather_code&temperature_unit=fahrenheit&timezone=auto`
        );

        const codeMap = {
            0: "Clear", 1: "Mainly Clear", 2: "Partly Cloudy", 3: "Overcast",
            45: "Foggy", 48: "Foggy", 51: "Light Drizzle", 53: "Drizzle", 55: "Heavy Drizzle",
            61: "Light Rain", 63: "Rain", 65: "Heavy Rain", 71: "Light Snow",
            73: "Snow", 75: "Heavy Snow", 80: "Showers", 81: "Showers", 82: "Heavy Showers",
            95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
        };

        const c = data.current || {};
        cachedWeather = {
            temp: Math.round(c.temperature_2m || 0),
            feels: Math.round(c.apparent_temperature || 0),
            condition: (codeMap[c.weather_code] || "Clear") + ` · ${cachedStatic.location.city}, ${cachedStatic.location.state}`,
        };

        console.log(`[${new Date().toISOString()}] Weather refreshed`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Weather refresh failed, keeping last known reading:`, err.message);
    }
}

function msUntilNextMidnight() {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0); // 12:05am, small buffer
    return nextMidnight - now;
}

function scheduleStaticRefresh() {
    refreshStaticData();
    setTimeout(scheduleStaticRefresh, msUntilNextMidnight());
}

// Retries the initial load a few times with backoff, so a transient outage at
// server boot doesn't leave the display permanently stuck with no data.
async function initialLoadWithRetry(fn, label, maxAttempts = 5) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await fn();
        const gotData = (label === 'static' && cachedStatic) || (label === 'weather' && cachedWeather);
        if (gotData) return;

        console.warn(`[${new Date().toISOString()}] ${label} still unavailable, retrying (${attempt}/${maxAttempts})...`);
        await new Promise(r => setTimeout(r, 5000 * attempt)); // 5s, 10s, 15s...
    }
    console.error(`[${new Date().toISOString()}] ${label} failed after ${maxAttempts} attempts — starting with no data, will retry on next scheduled refresh.`);
}

async function startServer() {
    await initialLoadWithRetry(refreshStaticData, 'static');
    await initialLoadWithRetry(refreshWeather, 'weather');

    scheduleStaticRefresh();                    // re-fetches once every 24h, aligned to midnight
    setInterval(refreshWeather, 15 * 60 * 1000); // every 15 min

    const server = http.createServer(async (req, res) => {
        const urlPath = req.url.split('?')[0]; // strip query string before routing/file resolution

        if (urlPath === "/api/calendar") {
            try {
                const icalUrl = `https://www.hebcal.com/hebcal?v=1&cfg=ics&maj=on&min=on&s=on&nx=on&mf=on&ss=on&o=on&c=on&lg=a&zip=${settings.zip}&m=${settings.havdalahMinutes}&year=now&ny=2`;

                let icalText;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 10000);
                        const icalRes = await fetch(icalUrl, {
                            headers: { "User-Agent": "Mozilla/5.0 (compatible; ZmanimBoard/1.0)" },
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);
                        if (!icalRes.ok) throw new Error(`Hebcal ICS request failed (${icalRes.status})`);
                        icalText = await icalRes.text();
                        break;
                    } catch (err) {
                        if (attempt === 3) throw err;
                        await new Promise(r => setTimeout(r, 1000 * attempt));
                    }
                }

                res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Access-Control-Allow-Origin": "*" });
                res.end(icalText);
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Calendar fetch failed:`, err.message);
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Failed to fetch calendar data" }));
            }
            return;
        }

        if (urlPath === "/api/data") {
            if (!cachedStatic) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Data not yet available, please try again shortly" }));
                return;
            }
            const dataArray = [
                cachedStatic.parashaObject, // may be null — frontend handles gracefully
                cachedStatic.dafYomiObject,
                cachedStatic.hebrewDateObject,
                cachedStatic.zmanim,
                cachedStatic.location,
                cachedWeather, // may be null if weather has never successfully loaded — frontend guards for this
                cachedStatic.shabbosTimes,
            ];
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(dataArray));
            return;
        }

        if (urlPath === "/api/settings" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(settings));
            return;
        }

        if (urlPath === "/api/settings" && req.method === "POST") {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const incoming = JSON.parse(body);

                    const mishpachasWord = (incoming.mishpachasWord || '').trim();
                    const familyName = (incoming.familyName || '').trim();

                    if (mishpachasWord.length > 20 || familyName.length > 20) {
                        throw new Error('Family name fields must be 20 characters or fewer');
                    }
                    if (!/^\d{5}$/.test(incoming.zip)) {
                        throw new Error('Invalid zip');
                    }
                    if (isNaN(incoming.havdalahMinutes) || incoming.havdalahMinutes < 0 || incoming.havdalahMinutes > 120) {
                        throw new Error('Invalid havdalah minutes');
                    }

                    // Spread existing settings first so fields not included in this
                    // request (e.g. photoFilename, only ever set by /api/photo) are
                    // preserved rather than wiped out.
                    settings = {
                        ...settings,
                        mishpachasWord,
                        familyName,
                        zip: incoming.zip,
                        havdalahMinutes: incoming.havdalahMinutes,
                    };
                    saveSettings(settings);

                    // Respond as soon as the settings are written, rather than
                    // making the person wait on a full Hebcal/weather refresh
                    // (which can take a while under a slow network, since each
                    // call has its own retry/backoff). The refresh still runs,
                    // just in the background — refreshStaticData/refreshWeather
                    // already catch their own errors internally, so a failure
                    // here can't crash the server or leave settings unsaved.
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));

                    refreshStaticData().then(() => refreshWeather());
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        if (urlPath === "/api/photo" && req.method === "POST") {
            let chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString());
                    const { photoData, photoExt } = body;
                    if (!photoData || !photoExt) throw new Error('Missing photo data');

                    const allowedExt = ['jpg', 'jpeg', 'png', 'webp'];
                    const ext = photoExt.toLowerCase().replace('.', '');
                    if (!allowedExt.includes(ext)) throw new Error('Unsupported file type');

                    const buffer = Buffer.from(photoData, 'base64');
                    if (buffer.length > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)');

                    const filename = `family-photo.${ext}`;
                    const imagesDir = path.join(import.meta.dirname, 'images');
                    fs.mkdirSync(imagesDir, { recursive: true });

                    // Clean up a previous upload with a different extension, so
                    // stale files don't accumulate on disk indefinitely.
                    if (settings.photoFilename && settings.photoFilename !== filename) {
                        const oldPath = path.join(imagesDir, settings.photoFilename);
                        fs.unlink(oldPath, () => {}); // best-effort, ignore errors (e.g. file didn't exist)
                    }

                    fs.writeFileSync(path.join(imagesDir, filename), buffer);

                    settings.photoFilename = filename;
                    settings.photoUpdatedAt = new Date().toISOString();
                    saveSettings(settings);

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, filename }));
                } catch (err) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        // Static file serving
        let filePath = path.join(import.meta.dirname, urlPath === "/" ? "index.html" : urlPath);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end(filePath);
                return;
            }
            res.end(data);
        });
    });

    server.listen(8000, () => console.log('Running on port 8000'));
}

startServer();
