/**
 * custody/scanner/pwa/scanner.js
 * Zero-install godown scan-in. Browser camera -> jsQR -> local dedupe ->
 * queued POST. Designed for the realities of an Indian warehouse:
 *   - flaky wifi: every scan queues to IndexedDB and syncs opportunistically
 *   - rush: instant audio/haptic feedback, no confirmation taps per box
 *   - honesty: duplicates and off-manifest scans are flagged LOUDLY, not silently dropped
 */

const params = new URLSearchParams(location.search);
const SESSION = params.get("s");          // signed scan-session token
const API = "/api/custody/scan";

let manifest = null;
const seen = new Set();                    // pieceIds accepted this session
let queue = [];                            // pending POSTs

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- bootstrap

async function boot() {
  const res = await fetch(`/api/custody/session/${SESSION}`);
  if (!res.ok) return fatal("Session invalid or expired. Ask for a new link.");
  manifest = await res.json();

  $("meta").textContent =
    `${manifest.pieceCount} pieces · booking ${manifest.bookingShort}`;
  $("of").textContent = `/ ${manifest.pieceCount}`;
  await loadQueue();
  render();
  startCamera();
  setInterval(flush, 4000);
  window.addEventListener("online", flush);
  window.addEventListener("online", () => $("offline").classList.remove("show"));
  window.addEventListener("offline", () => $("offline").classList.add("show"));
}

// ---------------------------------------------------------------- camera

async function startCamera() {
  const video = $("video");
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 } },
    });
    await video.play();
  } catch {
    return fatal("Camera blocked. Allow camera access, or use Enter ID.");
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const tick = () => {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (code) handlePayload(code.data);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- scan logic

function extractPieceId(payload) {
  // QR encodes a verify URL: https://…/v/DTD-XXXXXXXXXX
  const m = String(payload).match(/DTD-[0-9A-HJ-NP-TV-Z]{10}/);
  return m ? m[0] : null;
}

let lastAt = 0;
function handlePayload(payload) {
  const now = Date.now();
  if (now - lastAt < 350) return;         // debounce: one box lingering in frame
  const pieceId = extractPieceId(payload);
  if (!pieceId) return;
  lastAt = now;

  if (seen.has(pieceId)) return flag(pieceId, "DUPLICATE", "t-dup", "Already scanned");
  if (!manifest.pieceIds.includes(pieceId)) {
    // The loud case: a box that is NOT on this manifest.
    return flag(pieceId, "NOT ON MANIFEST", "t-bad", "Not on this manifest — set aside");
  }

  seen.add(pieceId);
  enqueue(pieceId);
  flag(pieceId, "OK", "t-ok", null);
  beep(880, 60);
  navigator.vibrate?.(40);
  render();
}

function flag(pieceId, tag, cls, toastMsg) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<span class="id">${pieceId}</span><span class="tag ${cls}">${tag}</span>`;
  $("log").prepend(row);

  if (toastMsg) {
    const t = $("toast");
    t.textContent = `${pieceId} — ${toastMsg}`;
    t.style.background = cls === "t-bad" ? "#b91c1c" : "#b45309";
    t.classList.add("show");
    beep(220, 200);
    navigator.vibrate?.([80, 60, 80]);
    setTimeout(() => t.classList.remove("show"), 2600);
  }
}

function render() {
  $("count").textContent = seen.size;
  const missing = manifest.pieceCount - seen.size;
  const s = $("status");
  if (missing === 0) { s.textContent = "COMPLETE"; s.style.color = "#0a7d3f"; }
  else { s.textContent = `${missing} missing`; s.style.color = "#b45309"; }
}

// ---------------------------------------------------------------- offline queue

async function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("dtd-scan", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("q", { keyPath: "nonce" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function enqueue(pieceId) {
  const item = {
    nonce: crypto.randomUUID(),
    session: SESSION,
    pieceId,
    manifestId: manifest.manifestId,
    scannedAt: new Date().toISOString(),
  };
  queue.push(item);
  const d = await db();
  d.transaction("q", "readwrite").objectStore("q").put(item);
  flush();
}

async function loadQueue() {
  const d = await db();
  const store = d.transaction("q", "readonly").objectStore("q");
  const all = await new Promise((res) => {
    const r = store.getAll();
    r.onsuccess = () => res(r.result || []);
  });
  queue = all.filter((i) => i.session === SESSION);
  queue.forEach((i) => seen.add(i.pieceId));
}

let flushing = false;
async function flush() {
  if (flushing || !navigator.onLine || queue.length === 0) return;
  flushing = true;
  const batch = queue.slice(0, 50);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: SESSION, scans: batch }),
    });
    if (res.ok) {
      const d = await db();
      const tx = d.transaction("q", "readwrite").objectStore("q");
      batch.forEach((i) => tx.delete(i.nonce));
      queue = queue.slice(batch.length);
    }
  } catch { /* stay queued */ }
  flushing = false;
}

// ---------------------------------------------------------------- finish

$("finish").onclick = async () => {
  await flush();
  const missing = manifest.pieceCount - seen.size;
  const msg = missing === 0
    ? `Confirm all ${manifest.pieceCount} pieces received?`
    : `⚠ ${seen.size} of ${manifest.pieceCount} scanned — ${missing} MISSING.\n\n` +
      `Signing records a SHORT delivery and freezes payment. Continue?`;
  if (!confirm(msg)) return;
  location.href = `/cosign/receiver/${SESSION}?count=${seen.size}`;
};

$("manual").onclick = () => {
  const v = prompt("Enter piece ID (DTD-XXXXXXXXXX)");
  if (v) handlePayload(v.trim().toUpperCase());
};

// ---------------------------------------------------------------- utils

function beep(freq, ms) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = freq; o.connect(g); g.connect(ac.destination);
    o.start(); setTimeout(() => { o.stop(); ac.close(); }, ms);
  } catch {}
}

function fatal(msg) {
  document.body.innerHTML =
    `<div style="padding:24px;font:16px system-ui"><b>Cannot start</b><p>${msg}</p></div>`;
}

boot();