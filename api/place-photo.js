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
//
// Nov 2026 (real-trip test): activities still drew wrong photos. "Private Day
// Trip to Nara" matched an Osaka tour company on the word "private" (an Osaka
// street); "Boulders Beach African Penguin Colony" took a guesthouse's
// veranda. Three changes:
//   1. Search for the PLACE, not the activity: words like private, day trip,
//      guided, tour, walk, sunset are taken out of the search and the name
//      match ("Private Day Trip to Nara" -> "Nara").
//   2. Hotels are skipped unless a hotel is what was asked for.
//   3. No good match, no photo: below a minimum name match it returns 404
//      and the page shows its plain tile instead of a guess.
import { withGuard } from "./_guard.js"
import { meter } from "./_meter.js"

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

// What you DO there, not where it is. Removed before searching and matching.
const ACTIVITY = new Set([
    "private", "guided", "guide", "tour", "tours", "day", "trip", "trips",
    "walk", "walking", "stroll", "hike", "hiking", "visit", "excursion",
    "experience", "class", "workshop", "session", "lesson", "morning",
    "afternoon", "evening", "night", "nighttime", "sunset", "sunrise", "dawn",
    "dusk", "cruise", "sailing", "charter", "small", "group", "half", "full",
    "skip", "line", "entry", "tickets", "ticket", "with", "by", "to", "from",
    "for", "your", "our", "self", "drive", "scenic", "winter", "summer",
    "tasting", "tastings", "crawl", "show", "hop", "menu", "dinner", "lunch",
    "breakfast", "brunch", "exploration",
])
// Only these come off the ends; "El", "La", "O", "Da" are part of a name.
const EDGE = new Set(["at", "on", "in", "of", "for", "with", "by", "to", "from", "and", "&", "+", "-", "\u2013", "\u2014", ":", "over", "around"])
// The place itself is a place to sleep: then a hotel hit is the right one.
const STAY_WORDS = /\b(hotel|inn|lodge|resort|ryokan|suites?|hostel|guest ?house|motel|b ?& ?b|pension|riad|villa|apartments?|homestay|camp)\b/i
const LODGING_TYPES = new Set([
    "lodging", "hotel", "resort_hotel", "motel", "inn", "hostel",
    "bed_and_breakfast", "guest_house", "campground", "cottage",
    "extended_stay_hotel", "farmstay", "private_guest_room", "budget_japanese_inn",
    "japanese_inn",
])
// Below this, no photo beats a wrong one: at least one distinctive word of
// the name (or about three generic ones, like "old town square") must match.
const MIN_MATCH = 0.9

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
// "Private Day Trip to Nara, Kyoto, Japan" -> venue words ["nara"] and the
// text to search for, "Nara, Kyoto, Japan". When only activity words remain
// (or nothing), the original is kept.
function placeQuery(query) {
    const parts = String(query).split(",")
    const head = parts[0]
    const rest = parts.slice(1).join(",")
    const toks = head
        .replace(/\([^)]*\)?/g, " ") // "(Private Catamaran)", "(Jose Avillez"
        .split(/\s+/)
        .filter(Boolean)
        .filter((w) => !ACTIVITY.has(w.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "")))
    // No dangling "at", "on", "&" at either end ("Shibuya Sky rooftop at").
    const edge = (w) => EDGE.has(w.toLowerCase())
    while (toks.length && edge(toks[0])) toks.shift()
    while (toks.length && edge(toks[toks.length - 1])) toks.pop()
    const kept = toks.join(" ").trim()
    const meaningful = words(kept).filter((w) => !GENERIC.has(w))
    const venue = meaningful.length ? kept : head
    return { venue, text: rest ? `${venue},${rest}` : venue }
}

function nameScore(query, name) {
    const want = words(String(query).split(",")[0])
    if (!want.length) return 0
    const got = new Set(words(name))
    const total = want.reduce((a, w) => a + weight(w), 0)
    return want.filter((w) => got.has(w)).reduce((a, w) => a + weight(w), 0) / total
}

// Enough of the name matched to trust the photo: one distinctive word
// ("Xochimilco", "Nara") is enough, so long titles are not punished.
function coverage(query, name) {
    const want = words(String(query).split(",")[0])
    if (!want.length) return 0
    const got = new Set(words(name))
    const total = want.reduce((a, w) => a + weight(w), 0)
    const hit = want.filter((w) => got.has(w)).reduce((a, w) => a + weight(w), 0)
    return Math.min(1, hit / Math.min(total, 1))
}

function pickPlace(query, places) {
    const wantStay = STAY_WORDS.test(String(query).split(",")[0])
    let best = null
    let bestScore = -1
    places.forEach((p, i) => {
        if (!p?.photos?.length) return
        const types = [
            ...(Array.isArray(p.types) ? p.types : []),
            ...(p.primaryType ? [p.primaryType] : []),
        ]
        if (types.some((t) => SKIP_TYPES.has(t))) return
        if (!wantStay && types.some((t) => LODGING_TYPES.has(t))) return
        if (coverage(query, p?.displayName?.text) < MIN_MATCH) return
        const match = nameScore(query, p?.displayName?.text)
        // Google's own order still counts for something: a small nudge to
        // the earlier hit when two names match equally well.
        const score = match - i * 0.05
        if (score > bestScore) {
            best = p
            bestScore = score
        }
    })
    return best
}

// Which of the place's photos (Google gives up to 10). Final test, Nov 2026:
// the first one was sometimes a visitor's selfie. The place's own photos
// (author = the place) come first, then landscape over portrait, then
// Google's order. Same request either way: the photo list already comes with
// each photo's author and size.
function pickPhoto(place) {
    const photos = Array.isArray(place?.photos) ? place.photos.slice(0, 10) : []
    if (!photos.length) return null
    const own = String(place?.displayName?.text || "").toLowerCase().trim()
    let best = photos[0]
    let bestScore = -1
    photos.forEach((ph, i) => {
        const authors = Array.isArray(ph?.authorAttributions) ? ph.authorAttributions : []
        const byPlace = own && authors.some((a) => String(a?.displayName || "").toLowerCase().trim() === own)
        const wide = Number(ph?.widthPx) > Number(ph?.heightPx)
        const score = (byPlace ? 4 : 0) + (wide ? 2 : 0) - i * 0.2
        if (score > bestScore) {
            best = ph
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

    const pq = placeQuery(query)
    try {
        // 1) Find the place + its best photo reference.
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
                body: JSON.stringify({ textQuery: pq.text, pageSize: 5 }),
            }
        )
        const searchData = await searchRes.json()
        if (searchData?.error) {
            console.error("[place-photo] Places error", searchData.error.status)
            await meter({ places_text_pro: 1, "err:places_photo": 1 })
            return send404() // not cached: retries once the account is fixed
        }
        const places = Array.isArray(searchData?.places) ? searchData.places : []
        const place = pickPlace(pq.text, places)
        const photoName = pickPhoto(place)?.name
        if (!photoName) {
            await meter({ places_text_pro: 1 })
            cache.set(query, { url: null, ts: Date.now() })
            return send404()
        }

        // 2) Resolve the photo to a key-free URL (skipHttpRedirect → JSON).
        const mediaRes = await fetch(
            `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=500&maxWidthPx=800&skipHttpRedirect=true&key=${KEY}`
        )
        const mediaData = await mediaRes.json()
        const url = mediaData?.photoUri || null
        await meter({ places_text_pro: 1, places_photo: 1, "err:places_photo": url ? 0 : 1 })
        cache.set(query, { url, ts: Date.now() })
        return url ? redirect(url) : send404()
    } catch {
        await meter({ "err:places_photo": 1 })
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
export { placeQuery, pickPlace, nameScore }

export default withGuard(handler, {
    prefix: "place-photo",
    limit: 150,
    windowSec: 60,
    dailyCap: 5000,
    requireOrigin: false,
    requireLimiter: false,
    meterCalls: false,
})
