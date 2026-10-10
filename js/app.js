/* Properties Near a School — Singapore
 * Data: HDB blocks (data.gov.sg/HDB via curated GeoJSON), optional private
 * buildings via Overpass (OpenStreetMap), OneMap basemap tiles.
 * No backend required — runs as a static site.
 */

// ---------------------------------------------------------------- state
const state = {
  center: null,        // {lat, lng} of the school
  radius: 2000,        // metres
  showHdb: true,
  showPrivate: false,
  hdb: null,           // parsed FeatureCollection
  hdbLayer: null,      // L.LayerGroup
  privateLayer: null,  // L.LayerGroup
  privateCache: null,  // {key, features}
  schools: null,       // parsed FeatureCollection (primary schools)
  schoolsLayer: null,  // L.LayerGroup
  schoolMarker: null,
  circles: [],
  overpassBusy: false,
};

const SG_CENTER = [1.3521, 103.8198];

// ---------------------------------------------------------------- map
const map = L.map("map", { zoomControl: true }).setView(SG_CENTER, 13);

L.tileLayer("https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.onemap.gov.sg/">OneMap</a> / SLA &middot; ' +
    'HDB data: <a href="https://data.gov.sg/">data.gov.sg</a> &middot; ' +
    'Private buildings: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// ---------------------------------------------------------------- helpers
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Fast bounding-box pre-filter (degrees) before exact haversine.
function inBbox(lat, lng, c, radiusM) {
  const dLat = radiusM / 110574;
  const dLng = radiusM / (111320 * Math.cos((c.lat * Math.PI) / 180));
  return Math.abs(lat - c.lat) <= dLat && Math.abs(lng - c.lng) <= dLng;
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.style.color = isError ? "#cf222e" : "";
}

// ---------------------------------------------------------------- circles & school marker
function drawCircles() {
  state.circles.forEach((c) => c.remove());
  state.circles = [];
  if (!state.center) return;
  const ll = [state.center.lat, state.center.lng];

  if (state.radius >= 2000) {
    state.circles.push(
      L.circle(ll, {
        radius: 1000,
        color: "#0969da",
        weight: 1.5,
        dashArray: "6 6",
        fill: false,
      }).addTo(map)
    );
  }
  state.circles.push(
    L.circle(ll, {
      radius: state.radius,
      color: "#d1242f",
      weight: 2,
      fill: true,
      fillColor: "#d1242f",
      fillOpacity: 0.04,
    }).addTo(map)
  );

  if (state.schoolMarker) state.schoolMarker.remove();
  state.schoolMarker = L.marker(ll, {
    icon: L.divIcon({ className: "", html: '🏫', iconSize: [30, 30], iconAnchor: [15, 15] }),
    zIndexOffset: 1000,
  })
    .addTo(map)
    .bindPopup(`<b>School (centre)</b>`);

  map.panTo(ll);
}

// ---------------------------------------------------------------- HDB layer
async function loadHdb() {
  const res = await fetch("data/hdb-blocks.geojson");
  state.hdb = await res.json();
  document.getElementById("status").textContent =
    `Loaded ${state.hdb.features.length} HDB blocks. Enter an address or click the map.`;
  if (state.center) {
    refreshResults();
    loadPrivate();
  }
}

// ---------------------------------------------------------------- results pipeline
// Collect HDB hits in radius, (re)build its markers, return results.
function collectHdb() {
  if (!state.hdbLayer) {
    state.hdbLayer = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 35,
      iconCreateFunction: (c) =>
        L.divIcon({
          html: `<div class="cluster-icon" style="width:36px;height:36px">${c.getChildCount()}</div>`,
          className: "",
          iconSize: L.point(36, 36),
        }),
    });
  }
  state.hdbLayer.clearLayers();

  const results = [];
  const c = state.center;
  if (state.hdb && c) {
    for (const f of state.hdb.features) {
      const [lng, lat] = f.geometry.coordinates;
      if (!inBbox(lat, lng, c, state.radius)) continue;
      const d = haversineMeters(c.lat, c.lng, lat, lng);
      if (d > state.radius) continue;
      results.push({ lat, lng, d, p: f.properties, kind: "hdb" });
    }
    for (const r of results) {
      const m = L.marker([r.lat, r.lng], {
        icon: L.divIcon({ className: "", html: '<div class="hdb-dot"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }),
      }).bindPopup(hdbPopup(r));
      state.hdbLayer.addLayer(m);
    }
  }
  if (state.showHdb) state.hdbLayer.addTo(map);
  else map.removeLayer(state.hdbLayer);
  return state.showHdb ? results : [];
}

// Collect private hits in radius from the OSM cache, (re)build markers.
function collectPrivate() {
  if (!state.privateLayer) state.privateLayer = L.layerGroup();
  state.privateLayer.clearLayers();

  const results = [];
  const c = state.center;
  // only trust the cache if it matches the current centre + radius
  const key = c ? `${c.lat.toFixed(4)},${c.lng.toFixed(4)},${state.radius}` : null;
  const feats =
    state.privateCache && state.privateCache.key === key
      ? state.privateCache.features
      : [];
  if (c) {
    for (const f of feats) {
      const d = haversineMeters(c.lat, c.lng, f.lat, f.lng);
      if (d > state.radius) continue;
      results.push({ lat: f.lat, lng: f.lng, d, p: f.p, kind: "private" });
      const m = L.marker([f.lat, f.lng], {
        icon: L.divIcon({ className: "", html: '<div class="priv-dot"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }),
      }).bindPopup(
        `<b>${escapeHtml(f.p.name)}</b><br>${escapeHtml(f.p.type || "building")}<br>` +
        `<span style="color:#bf3989;font-weight:600">${fmtDist(d)} from centre</span>`
      );
      state.privateLayer.addLayer(m);
    }
  }
  if (state.showPrivate) state.privateLayer.addTo(map);
  else map.removeLayer(state.privateLayer);
  return state.showPrivate ? results : [];
}

// Single entry point: rebuild both layers + merged, distance-sorted list.
function refreshResults() {
  const all = [...collectHdb(), ...collectPrivate()];
  all.sort((a, b) => a.d - b.d);
  renderList(all);
  if (state.center && !state.showHdb && !state.showPrivate) {
    setStatus("No property layer selected — enable HDB or Private.");
  }
}

function hdbPopup(r) {
  const p = r.p;
  return (
    `<div style="min-width:180px">` +
    `<b>${escapeHtml(p.n)}</b><br>` +
    `Blk ${p.b}, ${escapeHtml(p.s || "")} &middot; S${p.p}<br>` +
    `${p.st || "?"} storeys<br>` +
    `<span style="color:#0969da;font-weight:600">${fmtDist(r.d)} from centre</span>` +
    `<hr style="margin:6px 0;border:none;border-top:1px solid #eee">` +
    `<a href="https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}" target="_blank">Directions ↗</a>` +
    `</div>`
  );
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------------------------------------------------------------- results list
function renderList(results) {
  const listEl = document.getElementById("list");
  const countEl = document.getElementById("count");
  const c = state.center;

  if (!c) {
    countEl.textContent = "";
    listEl.innerHTML = '<div class="muted small">No centre set yet.</div>';
    return;
  }
  const srcs = [];
  if (state.showHdb) srcs.push("HDB");
  if (state.showPrivate) srcs.push("private");
  countEl.textContent = `${results.length} propert${results.length === 1 ? "y" : "ies"} within ${state.radius / 1000} km` +
    (srcs.length ? ` (${srcs.join(" + ")})` : "");

  if (!results.length) {
    listEl.innerHTML = '<div class="muted small">No properties found in this radius for the selected layers.</div>';
    return;
  }

  const MAX = 150;
  listEl.innerHTML = "";
  results.slice(0, MAX).forEach((r) => {
    const div = document.createElement("div");
    div.className = "list-item";
    const title = r.kind === "hdb" ? r.p.n : r.p.name;
    const sub =
      r.kind === "hdb"
        ? `Blk ${r.p.b} · ${r.p.s || ""} · S${r.p.p}`
        : `${r.p.type || "building"} (OpenStreetMap)`;
    div.innerHTML =
      `<span class="dist">${fmtDist(r.d)}</span>` +
      `<div class="name">${escapeHtml(title)}</div>` +
      `<div class="meta">${escapeHtml(sub)}</div>`;
    div.addEventListener("click", () => {
      map.flyTo([r.lat, r.lng], 18, { duration: 0.6 });
    });
    listEl.appendChild(div);
  });
  if (results.length > MAX) {
    const more = document.createElement("div");
    more.className = "muted small";
    more.style.padding = "4px";
    more.textContent = `…and ${results.length - MAX} more (see map markers).`;
    listEl.appendChild(more);
  }
}

// ---------------------------------------------------------------- private buildings (Overpass/OSM)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function overpassQuery(q) {
  let lastErr = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e; // try next endpoint
    }
  }
  throw new Error("all Overpass endpoints failed (" + (lastErr && lastErr.message) + ")");
}

async function loadPrivate() {
  const c = state.center;
  if (!c || !state.showPrivate) return;
  if (state.overpassBusy) return;

  const key = `${c.lat.toFixed(4)},${c.lng.toFixed(4)},${state.radius}`;
  if (state.privateCache && state.privateCache.key === key) {
    refreshResults();
    return;
  }

  state.overpassBusy = true;
  setStatus("Querying OpenStreetMap for private/named buildings…");
  refreshResults(); // show HDB-only list immediately while query runs
  const q = `
    [out:json][timeout:25];
    (
      node["building"~"^(residential|apartments|house|apartment|commercial)$"]["name"](around:${state.radius},${c.lat},${c.lng});
      way["building"~"^(residential|apartments)$"]["name"](around:${state.radius},${c.lat},${c.lng});
    );
    out center;
  `;
  try {
    const json = await overpassQuery(q);
    const feats = [];
    for (const el of json.elements || []) {
      let lat = el.lat, lng = el.lon;
      if (lat == null && el.center) { lat = el.center.lat; lng = el.center.lon; }
      if (lat == null || lng == null) continue;
      feats.push({ lat, lng, p: { name: el.tags.name, type: el.tags.building } });
    }
    state.privateCache = { key, features: feats };
    refreshResults();
    if (!feats.length) setStatus("OpenStreetMap: no named private buildings found in this radius.");
    else setStatus("");
  } catch (e) {
    setStatus("Overpass query failed: " + e.message, true);
  } finally {
    state.overpassBusy = false;
  }
}

// ---------------------------------------------------------------- geocoding
async function geocode(query) {
  const token = (document.getElementById("onemap-token").value || "").trim();
  if (token) {
    try {
      const res = await fetch(
        `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`,
        { headers: { Authorization: token } }
      );
      const json = await res.json();
      const r = (json.results || [])[0];
      if (r && r.LATITUDE && r.LONGITUDE) {
        return { lat: +r.LATITUDE, lng: +r.LONGITUDE, label: r.ADDRESS || query, via: "OneMap" };
      }
    } catch (e) {
      /* fall through to Nominatim */
    }
  }
  // Nominatim fallback (free, no key). 1 req/s.
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=sg&limit=1&q=${encodeURIComponent(query)}`
  );
  const arr = await res.json();
  if (!arr.length) throw new Error(`No results for "${query}"`);
  return { lat: +arr[0].lat, lng: +arr[0].lon, label: arr[0].display_name, via: "Nominatim/OSM" };
}

// ---------------------------------------------------------------- centre setting
function setCenter(lat, lng, label) {
  state.center = { lat, lng };
  drawCircles();
  refreshResults();
  loadPrivate();
  const where = label ? ` — ${label}` : "";
  setStatus(`Centre set${where}.`);
}

// ---------------------------------------------------------------- wire up UI
function onRadiusChange() {
  state.radius = +document.querySelector('input[name="radius"]:checked').value;
  state.privateCache = null;
  if (state.center) {
    drawCircles();
    refreshResults();
    loadPrivate();
  }
}

function onToggles() {
  state.showHdb = document.getElementById("hdb-toggle").checked;
  state.showPrivate = document.getElementById("private-toggle").checked;
  refreshResults();
  if (state.showPrivate && state.center) loadPrivate();
}

document.getElementById("locate-btn").addEventListener("click", async () => {
  const q = document.getElementById("addr").value.trim();
  if (!q) return;
  const btn = document.getElementById("locate-btn");
  btn.disabled = true;
  document.getElementById("geocode-status").textContent = "Searching…";
  try {
    const g = await geocode(q);
    setCenter(g.lat, g.lng, g.label);
    map.setView([g.lat, g.lng], 14);
    document.getElementById("geocode-status").textContent = `Found via ${g.via}`;
  } catch (e) {
    document.getElementById("geocode-status").textContent = e.message;
    document.getElementById("geocode-status").style.color = "#cf222e";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("addr").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("locate-btn").click();
});

map.on("click", (e) => {
  setCenter(e.latlng.lat, e.latlng.lng);
  document.getElementById("addr").value = "";
});

// "Set as centre" links inside school popups
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-school]");
  if (!el || !state.schools) return;
  const s = state.schools.features.find(
    (f) => f.properties.n === el.dataset.school
  )?.properties;
  if (!s) return;
  setCenter(s.lat, s.lng, s.n);
  map.setView([s.lat, s.lng], 14);
});

document.querySelectorAll('input[name="radius"]').forEach((r) => r.addEventListener("change", onRadiusChange));
document.getElementById("hdb-toggle").addEventListener("change", onToggles);
document.getElementById("private-toggle").addEventListener("change", onToggles);
document.getElementById("schools-toggle").addEventListener("change", (e) => {
  rebuildSchoolsLayer();
});

// persist OneMap token
const tokenInput = document.getElementById("onemap-token");
tokenInput.value = localStorage.getItem("onemap_token") || "";
tokenInput.addEventListener("change", () => localStorage.setItem("onemap_token", tokenInput.value.trim()));

// ---------------------------------------------------------------- schools (MOE via data.gov.sg)
async function loadSchools() {
  const res = await fetch("data/schools.geojson");
  state.schools = await res.json();
  buildSchoolPicker();
  document.getElementById("status").textContent =
    `Loaded ${state.hdb ? state.hdb.features.length : "…"} HDB blocks and ` +
    `${state.schools.features.length} primary schools. Pick a school or click the map.`;
  if (state.center) refreshResults();
}

function buildSchoolPicker() {
  const sel = document.getElementById("school-pick");
  // group by town (dgp code)
  const byTown = {};
  for (const f of state.schools.features) {
    const t = f.properties.t || "OTHER";
    (byTown[t] = byTown[t] || []).push(f.properties);
  }
  for (const town of Object.keys(byTown).sort()) {
    const group = document.createElement("optgroup");
    group.label = town;
    byTown[town].forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.n;
      opt.textContent = s.n;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  }
  sel.addEventListener("change", () => {
    const s = state.schools.features.find(
      (f) => f.properties.n === sel.value
    ).properties;
    setCenter(s.lat, s.lng, s.n);
    map.setView([s.lat, s.lng], 14);
    document.getElementById("addr").value = s.n;
  });
}

function rebuildSchoolsLayer() {
  if (state.schoolsLayer) state.schoolsLayer.clearLayers();
  else state.schoolsLayer = L.layerGroup();
  if (!state.schools) return;
  for (const f of state.schools.features) {
    const [lng, lat] = f.geometry.coordinates;
    const s = f.properties;
    L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: '<div class="school-dot"></div>',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      }),
      title: s.n,
    })
      .bindPopup(
        `<b>${escapeHtml(s.n)}</b><br>${escapeHtml(s.a)} S${s.p}<br>` +
        `<a href="javascript:void(0)" data-school="${escapeHtml(s.n)}">Set as centre</a>`
      )
      .addTo(state.schoolsLayer);
  }
  if (document.getElementById("schools-toggle").checked) state.schoolsLayer.addTo(map);
}

// ---------------------------------------------------------------- init
loadHdb().catch((e) => setStatus("Failed to load HDB data: " + e.message, true));
loadSchools().catch((e) => setStatus("Failed to load schools data: " + e.message, true));
