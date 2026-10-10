# Properties Near a School — Singapore

A static web app that shows **HDB blocks** (and optionally private/named buildings)
within a **1 km or 2 km circle** around any address — built for families checking
school proximity for P1 admission.

> ⚠️ **Not an admission tool.** MOE does not publish official catchment zones.
> P1 priority is proximity-based (1 km is the traditional threshold) plus other
> factors. Use this as a *reference*, and verify current MOE guidelines.

## Run it

Any static file server works:

```bash
cd school-property-map
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly via `file://` may fail on fetch() in some browsers — use a server.)

## Features

- 🗺️ **OneMap basemap** (Singapore Land Authority national map, free tiles)
- 🏫 **182 MOE primary schools** pre-loaded (data.gov.sg, geocoded via OneMap): quick-pick dropdown grouped by town, plus a map layer showing all schools with "Set as centre" popups
- 📍 **Set the school**: quick-pick, type an address (geocoded), or just **click the map**
- ⭕ **1 km / 2 km circles** around the centre (1 km shown dashed when 2 km is active)
- 🏢 **HDB blocks**: 9,749 residential blocks with estate name, block no, street, postal, storeys — markers + distance-sorted list
- 🏬 **Private buildings** (optional toggle): named residential buildings queried live from OpenStreetMap via Overpass API
- 📱 Mobile-friendly (panel collapses below map on narrow screens)

## Data sources

| Data | Source | Licence/notes |
|---|---|---|
| HDB blocks (name, street, postal, storeys, coords) | `data/hdb-blocks.geojson` — curated from HDB datasets on **data.gov.sg** (HDB Property Information + HDB Existing Building; via [gist](https://gist.github.com/incubated-geek-cc/2c6104143166fcae36495a51fefe1a34)) | Singapore Open Data Licence — free for personal & commercial use |
| Primary schools (name, address, postal, town, coords) | `data/schools.geojson` — **MOE "General information of schools"** on data.gov.sg (PRIMARY + P1-level mixed schools), geocoded with the OneMap Search API | Singapore Open Data Licence; OneMap geocoding free (token optional) |
| Basemap tiles | OneMap: `https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png` | Free; **OneMap logo/attribution required** (included in map attribution) |
| Geocoding | OneMap Search API (if you paste a token) else Nominatim/OSM | OneMap: free registration at onemap.gov.sg, token lasts 3 days. Nominatim: free, max 1 req/s, set a proper contact in usage policy |
| Private buildings | OpenStreetMap via Overpass API (`overpass-api.de`) | ODbL — attribution included |

## Files

```
index.html          UI (Leaflet + markercluster via CDN)
css/app.css         styling
js/app.js           map, radius filtering (haversine), geocoding, Overpass
data/hdb-blocks.geojson  9,749 residential HDB block points (~1.6 MB)
```

## Refreshing the HDB data

The block dataset is static. To refresh:

1. Download fresh HDB data from data.gov.sg:
   - HDB Property Information: `https://data.gov.sg/datasets/d_17f5382f26140b1fdae0ba2ef6239d2f/view`
   - HDB Existing Building (GeoJSON): `https://data.gov.sg/datasets/d_16b157c52ed637edd6ba1232e026258d/view`
2. Re-join by block number + postal code, take residential blocks, emit slim points.
3. Replace `data/hdb-blocks.geojson` (same schema: `properties: {n, b, s, p, st}`).

### Refreshing the school list

1. Download MOE "General information of schools" from data.gov.sg (dataset `d_688b934f82c1059ed0a6993d2a829089`).
2. Keep rows where `mainlevel_code` is `PRIMARY` or `MIXED LEVEL (P1-S4)`.
3. Geocode each school name with the OneMap Search API (`/api/common/elastic/search?searchVal=<name>&returnGeom=Y`), ~1 req/s, preferring results whose `POSTAL` matches. Spot-check mismatches (OneMap name search can occasionally pick a wrong campus; verify with a postal-code search).
4. Replace `data/schools.geojson` (schema: `properties: {n, a, p, t, lat, lng}`).

## Ideas for next steps

- **Walking distance** via OSRM instead of straight-line
- **HDB resale prices** (data.gov.sg) in the popup for price context
- **MRT/bus stops** layer (data.gov.sg LTA data)
- Active **for-sale listings** (99.co/SRX via RapidAPI or Apify) — the original goal
- Small backend (PostGIS) if the dataset grows or you want server-side radius queries
