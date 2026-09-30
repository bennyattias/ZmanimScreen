// ── Helpers ──────────────────────────────────────────────────────────────────

// Extracts a time like "7:23pm" from a Hebcal title such as
// "Candle lighting: 7:23pm" — robust to title format/length changes,
// unlike a fixed slice() offset.
function extractTimeFromTitle(title) {
    if (!title) return '--';
    const match = title.match(/(\d{1,2}:\d{2}\s*[ap]m)/i);
    return match ? match[1] : '--';
}

// ── Zmanim live highlighting ────────────────────────────────────────────────
// zmanimSchedule holds { date, row } pairs built once per fetchData() call.
// updateZmanimHighlight() runs every second and just toggles classes — no
// re-fetching or re-rendering of HTML, so it's cheap to run continuously.

let zmanimSchedule = [];

function updateZmanimHighlight() {
    const now = new Date();

    zmanimSchedule.forEach(({ date, row }) => {
        row.classList.toggle('zman-upcoming', date > now);
    });

    // Gold background only on the first (soonest) upcoming one
    const upcomingRows = document.querySelectorAll('.zman-upcoming');
    upcomingRows.forEach((row, i) => {
        row.style.backgroundColor = i === 0 ? 'rgba(173, 129, 33, 0.54)' : '';
    });
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchData() {
    try {
        const res = await fetch("/api/data");
        if (!res.ok) throw new Error(`/api/data returned ${res.status}`);
        const data = await res.json();

        // Parasha — may be a holiday name instead of a regular parasha on
// weeks where a Yom Tov falls on Shabbos (e.g. Sukkos); the "פרשת"
// prefix is already included in the string when applicable, so it's
// rendered as-is. May also be null in rare edge cases — handled
// gracefully rather than crashing the rest of fetchData().
        document.getElementById("parasha").innerHTML = data[0]?.he ?? "";

        // Daf Yomi
        if (data[1]?.displayValue?.he) {
            document.getElementById("daf-yomi-he").innerHTML = data[1].displayValue.he;
            document.getElementById("daf-yomi-en").innerHTML = data[1].displayValue.en;
        } else {
            document.getElementById("daf-yomi-he").innerHTML = "";
            document.getElementById("daf-yomi-en").innerHTML = "";
        }

        // Hebrew date
        document.getElementById("hebrew-date").innerHTML = data[2];

        // Zmanim rows
        document.getElementById("zmanim").innerHTML = data[3].map((zman) => {
            return `
        <div class="zman-row">
            <p class="zman-time">${zman.time}</p>
            <p class="zman-he">${zman.he}</p>
        </div>
    `;
        }).join("");

        // Build the schedule used for live highlighting (see updateZmanimHighlight)
        const rows = document.querySelectorAll('#zmanim .zman-row');
        zmanimSchedule = data[3].map((zman, i) => {
            // Match "4:32 PM", "4:32PM", or "4:32pm" — space optional, case-insensitive
            const match = zman.time.match(/(\d+):(\d+)\s*(am|pm)/i);
            if (!match) return null;
            const [, hours, minutes, period] = match;

            let hour = parseInt(hours);
            if (period.toLowerCase() === "pm" && hour !== 12) hour += 12;
            if (period.toLowerCase() === "am" && hour === 12) hour = 0;

            const zmanDate = new Date();
            zmanDate.setHours(hour, parseInt(minutes), 0, 0);

            return { date: zmanDate, row: rows[i] };
        }).filter(Boolean);
        updateZmanimHighlight(); // paint immediately, don't wait for the next tick

        // Weather — the only piece of data[] that changes within a day,
        // refreshed server-side every 15 min. May briefly be unavailable if
        // the server's own weather fetch has failed, so guard with fallbacks.
        document.getElementById("temperature").innerHTML   = (data[5]?.temp ?? '--') + "°F";
        document.getElementById("feels-like").innerHTML    = "feels " + (data[5]?.feels ?? '--') + "°";
        document.getElementById("weather-condition").innerHTML = data[5]?.condition ?? 'Weather unavailable';

        // Shabbos times — regex-extracted rather than sliced by fixed
        // character offsets, so a Hebcal title format change won't silently
        // produce garbage.
        document.getElementById("candle-lighting-time").innerHTML =
            extractTimeFromTitle(data[6]?.candleLightingObject?.title);
        document.getElementById("havdalah-time").innerHTML =
            extractTimeFromTitle(data[6]?.havdalahObject?.title);

    } catch (err) {
        console.error("Failed to fetch data:", err);
    }
}

// ── Photo slideshow ──────────────────────────────────────────────────────────
// Plays the photo list from /api/photos (synced Google Drive photos, or the
// single uploaded photo as a fallback), shuffled, crossfading between them.

let slideshowPhotos = [];
let slideshowOrder = [];
let slideshowIndex = 0;
let slideSeconds = 20;
let slideTimer = null;

// Aspect ratio threshold — images with ratio below this get portrait treatment
// 1.0 = square, below 1.0 = portrait, above 1.0 = landscape
const PORTRAIT_THRESHOLD = 1.2;

// Builds one slide layer (blurred backdrop + photo) from an already-loaded image.
function buildSlide(img, url) {
    const slide = document.createElement('div');
    slide.className = 'photo-slide';
    slide.dataset.url = url;

    const backdrop = document.createElement('div');
    backdrop.className = 'photo-backdrop';

    const ratio = img.naturalWidth / img.naturalHeight;
    if (ratio < PORTRAIT_THRESHOLD) {
        // Portrait — contain + blurred backdrop
        img.style.objectFit = 'contain';
        backdrop.style.backgroundImage = `url('${img.src}')`;
        backdrop.style.display = 'block';
    } else {
        // Landscape — cover, no backdrop
        img.style.objectFit = 'cover';
    }

    slide.append(backdrop, img);
    return slide;
}

function shuffle(list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// Preloads and decodes the next photo before it starts fading in, so the
// dissolve never shows a half-loaded image. The new slide fades in on top of
// the current one, which is removed only once it's fully covered.
function showPhoto(url) {
    const inner = document.querySelector('.photo-inner');
    const slides = inner.querySelectorAll('.photo-slide');
    const current = slides[slides.length - 1];
    if (current && current.dataset.url === url) return; // a reshuffle landed on the photo already showing

    const preload = new Image();
    preload.onload = async () => {
        // Decode up front so the fade doesn't stutter. Capped, because decode()
        // never settles while the page is hidden, which would stall the slideshow.
        await Promise.race([preload.decode().catch(() => {}), new Promise(r => setTimeout(r, 1000))]);
        const slide = buildSlide(preload, url);
        const previous = [...inner.querySelectorAll('.photo-slide')];
        inner.insertBefore(slide, inner.querySelector('.photo-frame-shadow'));

        // First photo on page load (nothing to dissolve from), or the page is
        // hidden (browsers pause transitions then, so a fade would stall
        // half-done) — just swap. Without a style flush beforehand, adding
        // .visible straight away makes the slide appear at full opacity.
        if (!previous.length || document.hidden) {
            slide.classList.add('visible');
            previous.forEach(p => p.remove());
            return;
        }

        // Keep only the photo currently on top as the underlay; anything older
        // is already hidden beneath it. Bounds the layer count if fades stall
        // (browsers pause transitions while the page is hidden).
        previous.slice(0, -1).forEach(p => p.remove());

        // The underlay is removed only once the new slide is fully opaque —
        // never on a timer — so the frame's background can't show through.
        slide.addEventListener('transitionend', () => {
            previous.forEach(p => p.remove());
        }, { once: true });

        // Force a style flush so the slide registers at opacity 0 first —
        // otherwise the transition is skipped and it just pops in.
        void slide.offsetWidth;
        slide.classList.add('visible');
    };
    preload.onerror = () => {
        console.warn('Skipping photo that failed to load:', url);
        if (slideshowOrder.length > 1) advanceSlideshow();
    };
    preload.src = url;
}

function advanceSlideshow() {
    if (!slideshowOrder.length) return;
    slideshowIndex++;
    if (slideshowIndex >= slideshowOrder.length) {
        slideshowOrder = shuffle(slideshowPhotos);
        slideshowIndex = 0;
    }
    showPhoto(slideshowOrder[slideshowIndex]);
}

function restartSlideTimer() {
    clearInterval(slideTimer);
    if (slideshowPhotos.length > 1) {
        slideTimer = setInterval(advanceSlideshow, slideSeconds * 1000);
    }
}

// Picks up new/removed Drive photos without restarting the slideshow from
// scratch — the current photo stays up unless it was removed.
async function refreshPhotoList({ forceReload = false } = {}) {
    try {
        const res = await fetch('/api/photos');
        if (!res.ok) throw new Error(`/api/photos returned ${res.status}`);
        const data = await res.json();

        const listChanged = data.photos.join('|') !== slideshowPhotos.join('|');
        const timingChanged = data.slideSeconds !== slideSeconds;
        slideSeconds = data.slideSeconds;

        if (listChanged || forceReload) {
            slideshowPhotos = data.photos;
            const current = slideshowOrder[slideshowIndex];
            slideshowOrder = shuffle(slideshowPhotos);
            slideshowIndex = 0;

            if (!forceReload && current && slideshowPhotos.includes(current)) {
                // Keep showing the current photo; it becomes position 0 of the new order.
                slideshowOrder = [current, ...slideshowOrder.filter(url => url !== current)];
            } else {
                // Cache-bust on a forced reload so a re-uploaded family photo
                // with the same filename actually shows up.
                const url = slideshowOrder[0];
                showPhoto(forceReload ? `${url}?t=${Date.now()}` : url);
            }
            restartSlideTimer();
        } else if (timingChanged) {
            restartSlideTimer();
        }

        return data.driveSyncStatus;
    } catch (err) {
        console.error('Failed to load photo list:', err);
        return null;
    }
}

function renderDriveSyncStatus(status) {
    const el = document.getElementById('driveSyncStatus');
    if (!status) { el.textContent = ''; return; }
    const when = status.lastSyncAt
        ? ` · last sync ${new Date(status.lastSyncAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : '';
    el.textContent = status.message + when;
    el.classList.toggle('error', status.ok === false);
}

// ── Clock ─────────────────────────────────────────────────────────────────────

function updateClock() {
    const now = new Date();
    const time12 = now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });

    // Gregorian date in header
    document.getElementById("date").innerHTML = now.toDateString();

    // Split "10:46 PM" into time and AM/PM
    const [time, period] = time12.split(" ");
    document.getElementById("clock").textContent      = time;
    document.getElementById("time-of-day").textContent = period;
}

// ── Settings modal ───────────────────────────────────────────────────────────

const HEBREW_KEYS = [
    'א','ב','ג','ד','ה','ו','ז',
    'ח','ט','י','כ','ל','מ','נ',
    'ס','ע','פ','צ','ק','ר','ש','ת',
    'ך','ם','ן','ף','ץ'
];

function buildHebrewKeyboard() {
    const kb = document.getElementById('hebrewKeyboard');
    kb.innerHTML = '';

    HEBREW_KEYS.forEach((letter) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = letter;
        btn.addEventListener('click', () => insertAtCursor(letter));
        kb.appendChild(btn);
    });

    const space = document.createElement('button');
    space.type = 'button';
    space.textContent = 'space';
    space.className = 'kb-wide';
    space.addEventListener('click', () => insertAtCursor(' '));
    kb.appendChild(space);

    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '⌫';
    back.className = 'kb-wide';
    back.addEventListener('click', () => backspaceAtCursor());
    kb.appendChild(back);
}

let activeKeyboardInput = null;

function insertAtCursor(char) {
    if (!activeKeyboardInput) return;
    const input = activeKeyboardInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + char + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + char.length;
    input.focus();
}

function backspaceAtCursor() {
    if (!activeKeyboardInput) return;
    const input = activeKeyboardInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    if (start === end && start > 0) {
        input.value = input.value.slice(0, start - 1) + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start - 1;
    } else {
        input.value = input.value.slice(0, start) + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start;
    }
    input.focus();
}

document.querySelectorAll('.kb-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const targetInput = document.getElementById(targetId);
        const kb = document.getElementById('hebrewKeyboard');

        const alreadyOpenForThis = !kb.hidden && activeKeyboardInput === targetInput;

        document.querySelectorAll('.kb-toggle').forEach((b) => b.classList.remove('active'));

        if (alreadyOpenForThis) {
            kb.hidden = true;
            activeKeyboardInput = null;
        } else {
            kb.hidden = false;
            activeKeyboardInput = targetInput;
            btn.classList.add('active');
            targetInput.focus();
        }
    });
});

buildHebrewKeyboard();

async function loadSettingsIntoForm() {
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error(`/api/settings returned ${res.status}`);
        const settings = await res.json();

        document.getElementById('mishpachasInput').value = settings.mishpachasWord;
        document.getElementById('familyNameInput').value = settings.familyName;
        document.getElementById('zipInput').value          = settings.zip;
        document.getElementById('havdalahInput').value     = settings.havdalahMinutes;
        document.getElementById('photoPreview').src        = `/images/${settings.photoFilename}`;
        document.getElementById('driveFolderInput').value  = settings.driveFolderUrl || '';
        document.getElementById('slideSecondsInput').value = settings.slideSeconds;
        const keyInput = document.getElementById('driveApiKeyInput');
        keyInput.value = '';
        keyInput.placeholder = settings.driveApiKeySet ? 'Saved — leave blank to keep' : 'Paste your API key';
    } catch (err) {
        console.error('Failed to load settings:', err);
    }
}

// ── Photo upload ─────────────────────────────────────────────────────────────

document.getElementById('photoInput').addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;

    const preview = document.getElementById('photoPreview');
    preview.src = URL.createObjectURL(file); // instant local preview, no upload yet
});

// Resizes/compresses an image client-side before upload — a raw phone photo
// can be 3-10+ MB, far larger than this display will ever render it at, so
// downscaling here dramatically cuts upload time and stored file size.
function resizeImageFile(file, maxDimension = 1600, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
            let { width, height } = img;

            if (width > maxDimension || height > maxDimension) {
                if (width > height) {
                    height = Math.round(height * (maxDimension / width));
                    width = maxDimension;
                } else {
                    width = Math.round(width * (maxDimension / height));
                    height = maxDimension;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);

            canvas.toBlob((blob) => {
                URL.revokeObjectURL(objectUrl);
                if (!blob) { reject(new Error('Failed to compress image')); return; }
                resolve(blob);
            }, 'image/jpeg', quality);
        };

        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed to load image'));
        };

        img.src = objectUrl;
    });
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]); // strip data: prefix
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function uploadPhotoIfSelected() {
    const fileInput = document.getElementById('photoInput');
    const file = fileInput.files[0];
    if (!file) return null; // nothing selected — leave existing photo as-is

    const resizedBlob = await resizeImageFile(file);
    const photoData = await readFileAsBase64(resizedBlob);

    const res = await fetch('/api/photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoData, photoExt: 'jpg' }) // always jpg, since canvas re-encodes to it
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Photo upload failed');
    }

    const result = await res.json();
    fileInput.value = ''; // reset so the same file can be re-selected later if needed
    return result.filename;
}

document.getElementById('settingsForm').addEventListener('submit', async function(e) {
    e.preventDefault();

    const status = document.getElementById('settingsStatus');
    status.textContent = 'Saving…';

    // Photo upload runs independently of the name/zip/havdalah fields below —
    // a photo change should go through even if the name fields are empty or
    // invalid, and a name/zip change shouldn't be blocked by a photo issue.
    let photoFilename = null;
    let photoError = null;
    try {
        photoFilename = await uploadPhotoIfSelected();
        if (photoFilename) {
            await refreshPhotoList({ forceReload: true });
        }
    } catch (err) {
        console.error('Failed to upload photo:', err);
        photoError = err.message || 'Photo upload failed';
    }

    const payload = {
        mishpachasWord:  document.getElementById('mishpachasInput').value.trim(),
        familyName:      document.getElementById('familyNameInput').value.trim(),
        zip:             document.getElementById('zipInput').value.trim(),
        havdalahMinutes: parseInt(document.getElementById('havdalahInput').value, 10),
        driveFolderUrl:  document.getElementById('driveFolderInput').value.trim(),
        driveApiKey:     document.getElementById('driveApiKeyInput').value.trim(), // blank = keep saved key
        slideSeconds:    parseInt(document.getElementById('slideSecondsInput').value, 10),
    };

    if (payload.mishpachasWord.length > 20 || payload.familyName.length > 20) {
        status.textContent = (photoError ? photoError + ' — ' : photoFilename ? 'Photo saved. ' : '') + 'Family name fields must be 20 characters or fewer';
        return;
    }

    try {
        const saveRes = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!saveRes.ok) {
            const err = await saveRes.json();
            throw new Error(err.error || 'Save failed');
        }

        document.getElementById('mishpachas-word').textContent = payload.mishpachasWord;
        document.getElementById('family-name-text').textContent = payload.familyName;

        status.textContent = photoError ? `Saved ✓ (photo: ${photoError})` : 'Saved ✓';
        await fetchData();
        renderDriveSyncStatus(await refreshPhotoList());
        loadSettingsIntoForm(); // clears the key field and updates its "Saved" placeholder

        if (window.zmanimCalendar) {
            window.zmanimCalendar.refetchEvents();
        }

        // The server responds as soon as settings.json is written and
        // refreshes zmanim/weather/calendar data in the background, so a
        // zip or havdalah change may not be reflected yet by the fetchData()
        // call just above. A short follow-up catches it once that
        // background refresh has had time to complete.
        setTimeout(() => {
            fetchData();
            if (window.zmanimCalendar) {
                window.zmanimCalendar.refetchEvents();
            }
        }, 3000);

        // A Drive folder change kicks off a sync that downloads every photo,
        // which takes longer than the zmanim refresh — check back a few times.
        [10000, 30000, 90000].forEach(delay => setTimeout(async () => {
            renderDriveSyncStatus(await refreshPhotoList());
        }, delay));

        setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (err) {
        console.error('Failed to save settings:', err);
        status.textContent = err.message || 'Failed to save';
    }
});

// ── Init ──────────────────────────────────────────────────────────────────────

setInterval(updateClock, 1000);
setInterval(updateZmanimHighlight, 1000);
updateClock();
fetchData();
setInterval(fetchData, 15 * 60 * 1000); // matches the server's weather refresh cadence

refreshPhotoList();
setInterval(refreshPhotoList, 5 * 60 * 1000); // picks up newly synced Drive photos

loadSettingsIntoForm().then(() => {
    document.getElementById('mishpachas-word').textContent = document.getElementById('mishpachasInput').value;
    document.getElementById('family-name-text').textContent = document.getElementById('familyNameInput').value;
});

// Get the modal
var modal = document.getElementById("myModal");

// Get the button that opens the modal
var btn = document.getElementById("settingsBtn");

// Get the <span> element that closes the modal
var span = document.getElementsByClassName("close")[0];

// When the user clicks on the button, open the modal
btn.onclick = function() {
    modal.style.display = "flex";
    loadSettingsIntoForm();
    refreshPhotoList().then(renderDriveSyncStatus);
}

// When the user clicks on <span> (x), close the modal
span.onclick = function() {
    modal.style.display = "none";
}

// When the user clicks anywhere outside of the modal, close it
window.onclick = function(event) {
    if (event.target == modal) {
        modal.style.display = "none";
    }
}
