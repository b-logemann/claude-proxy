// Returns a real venue photo via Google Places (New). Looks the place up by
// text query, resolves its first photo to a key-free googleusercontent URL,
// and 302-redirects the <img> straight to it. Cached in-memory per query to
// keep Places billing down across repeat loads (resets on cold start).
//
// Nov 2026 (persona test L5): the first search hit was sometimes the wrong
// place - a parking lot next to the sight, or a different temple with a
// similar name. Now it looks at the top 5 hits, skips car parks, roads and
// other non-places, and takes the one whose name best matches what was asked
// for. Same Places SKU as before plus `types`; still one search per query.
import { withGuard } from "./_guard.js"

const KEY = process.env.GOOGLE_PLACES_API_KEY
const cache = new Map() // query -> { url: string|null, ts: number }
const TTL = 1000 * 60 * 60 * 24 // 24h

// Never the photo for a venue: these are what sits next to it.
const SKIP_TYPES = new Set([
    "parking",
    "parking_lot",
    "parking_garage",
    "route",
    "street_address",
    "intersection",
    "premise",
    "plus_code",
    "postal_code",
    "bus_stop",
    "bus_station",
    "transit_station",
    "taxi_stand",
    "gas_station",
    "electric_vehicle_charging_station",
    "car_rental",
    "atm",
])

const STOP = new Set([
    "the", "a", "an", "of", "and", "at", "in", "on", "de", "la", "le", "du",
    "des", "di", "da", "del", "el", "il", "tour", "visit", "walk", "dinner",
    "lunch", "evening", "morning", "free", "exploration",
])
const words = (s) =>
    String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP.has(w))

// How well a hit's name matches the venue part of the query (before the
// first comma: "Chion-in Temple, Kyoto, Japan" -> "Chion-in Temple").
// Words that half the places in a city share count for little: "Chion-in
// Temple" must match on "chion", not on "temple".
const GENERIC = new Set([
    "temple", "shrine", "church", "cathedral", "basilica", "museum", "gallery",
    "palace", "castle", "park", "garden", "gardens", "market", "square",
    "piazza", "plaza", "bridge", "tower", "restaurant", "cafe", "bar",
    "hotel", "beach", "street", "old", "town", "city", "national", "san",
    "santa", "st", "saint", "royal", "grand", "great", "new",
])
const weight = (w) => (GENERIC.has(w) ? 0.3 : 1)
function nameScore(query, name) {
    const want = words(String(query).split(",")[0])
    if (!want.length) return 0
    const got = new Set(words(name))
    const total = want.reduce((a, w) => a + weight(w), 0)
    return want.filter((w) => got.has(w)).reduce((a, w) => a + weight(w), 0) / total
}

function pickPlace(query, places) {
    let best = null
    let bestScore = -1
    places.forEach((p, i) => {
        if (!p?.photos?.length) return
        const types = [
            ...(Array.isArray(p.types) ? p.types : []),
            ...(p.primaryType ? [p.primaryType] : []),
        ]
        if (types.some((t) => SKIP_TYPES.has(t))) return
        // Google's own order still counts for something: a small nudge to
        // the earlier hit when two names match equally well.
        const score = nameScore(query, p?.displayName?.text) - i * 0.05
        if (score > bestScore) {
            best = p
            bestScore = score
        }
    })
    return best
}

async function handler(req, res) {
    const query = (req.query.query || "").toString().trim()
    if (!query) {
        res.statusCode = 400
        return res.end("missing query")
    }

    const send404 = () => {
        res.statusCode = 404
        return res.end()
    }
    const redirect = (url) => {
        res.statusCode = 302
        res.setHeader("Location", url)
        res.setHeader("Cache-Control", "public, max-age=86400")
        return res.end()
    }

    const hit = cache.get(query)
    if (hit && Date.now() - hit.ts < TTL) {
        return hit.url ? redirect(hit.url) : send404()
    }

    try {
        // 1) Find the place + its first photo reference.
        const searchRes = await fetch(
            "https://places.googleapis.com/v1/places:searchText",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": KEY,
                    "X-Goog-FieldMask":
                        "places.photos,places.displayName,places.types,places.primaryType",
                },
                body: JSON.stringify({ textQuery: query, pageSize: 5 }),
            }
        )
        const searchData = await searchRes.json()
        const places = Array.isArray(searchData?.places) ? searchData.places : []
        const place = pickPlace(query, places)
        const photoName = place?.photos?.[0]?.name
        if (!photoName) {
            cache.set(query, { url: null, ts: Date.now() })
            return send404()
        }

        // 2) Resolve the photo to a key-free URL (skipHttpRedirect → JSON).
        const mediaRes = await fetch(
            `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=500&maxWidthPx=800&skipHttpRedirect=true&key=${KEY}`
        )
        const mediaData = await mediaRes.json()
        const url = mediaData?.photoUri || null
        cache.set(query, { url, ts: Date.now() })
        return url ? redirect(url) : send404()
    } catch {
        return send404()
    }
}

// This endpoint was previously unguarded entirely - no CORS, no rate limiting -
// while billing Google Places on every miss. Three deliberate choices here:
//
//   requireOrigin: false  - MUST be false. This is consumed as <img src> and as
//                           a CSS background-image, neither of which sends an
//                           Origin header. Set it true and every photo 403s.
//
//   limit: 150/60s        - deliberately generous. One trip page is a hero plus
//                           ~25 thumbnails, so a single page view is 25-30 calls.
//                           A tight per-IP limit here blocks your own users, not
//                           attackers. Browser caching (max-age=86400) and the
//                           in-memory cache above both reduce repeat traffic.
//
//   requireLimiter: false - a Redis outage should not break every image on the
//                           site. Photos are cosmetic and individually cheap;
//                           dailyCap is what bounds the Places bill.
export default withGuard(handler, {
    prefix: "place-photo",
    limit: 150,
    windowSec: 60,
    dailyCap: 5000,
    requireOrigin: false,
    requireLimiter: false,
})
