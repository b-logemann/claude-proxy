// api/place-link.js - resolves venues to their REAL website via Google Places.
//
// Why this exists: Book It was sending every restaurant to OpenTable/Resy and
// every experience to Viator + GetYourGuide, whether or not those platforms
// operate where the traveller is going. A hotel restaurant or a local guide is
// on none of them, so the link returned nothing. With affiliate earning off
// there is no reason to route through an aggregator at all - the venue's own
// site is simply the better answer.
//
// It deliberately does NOT ask the model for a URL. Claude will produce a
// perfectly-formed website for any venue you name and some fraction will be
// wrong - which is bugs #5, #8 and #10 in the rebuild notes, three times over.
// Places returns the website the business itself registered, or nothing.
//
// Batched on purpose: one request per trip page rather than ~25, so the
// component makes a single call and the fan-out happens here.
//
// COST NOTE: `websiteUri` sits in a more expensive Places billing tier than
// the fields place-photo.js requests. The cache below and the dailyCap in the
// guard are what keep that bounded. Watch it against the budget alert.

import { withGuard } from "./_guard.js"

export const maxDuration = 30

const KEY = process.env.GOOGLE_PLACES_API_KEY

const cache = new Map() // query -> { v: {website?, maps?, lodging?}, ts: number }

// Google's lodging types (Places API New, "Lodging" table). A stay the model
// suggests must come back as one of these; a restaurant or bar that happens to
// be called "Hotel ..." (Paris's Hotel du Nord) does not.
const LODGING = new Set([
    "lodging", "hotel", "motel", "inn", "hostel", "guest_house",
    "bed_and_breakfast", "resort_hotel", "extended_stay_hotel", "farmstay",
    "cottage", "private_guest_room", "japanese_inn", "budget_japanese_inn",
    "campground", "camping_cabin", "rv_park",
])
const TTL = 1000 * 60 * 60 * 24 // 24h

// Is Google's top hit the place we asked about? (Final test, Nov 2026: a
// generic "Aurora Alert Walk" matched some business in Vellir, and its
// neighbourhood and website were used as if they were the walk's.) Share of
// the asked-for name's telling words found in Google's name; words every
// city has ("temple", "museum", "hotel") count for little.
const STOP = new Set([
    "the", "a", "an", "of", "and", "at", "in", "on", "de", "la", "le", "du",
    "des", "di", "da", "del", "el", "il", "by", "for", "with", "to",
])
const GENERIC = new Set([
    "temple", "shrine", "church", "cathedral", "basilica", "museum", "gallery",
    "palace", "castle", "park", "garden", "gardens", "market", "square",
    "piazza", "plaza", "bridge", "tower", "restaurant", "cafe", "bar", "bistro",
    "hotel", "inn", "ryokan", "resort", "suites", "beach", "street", "old",
    "town", "city", "centre", "center", "national", "san", "santa", "st",
    "saint", "royal", "grand", "great", "new", "kitchen", "grill", "house",
    "tour", "walk", "visit", "private", "guided", "small", "group", "class",
    "tasting", "experience", "sunset", "evening", "night", "morning", "day",
    "trip", "dinner", "lunch", "breakfast", "free", "exploration", "stroll",
    "hike", "sail", "cruise", "wine", "beer", "mezcal", "cocktail", "cocktails",
    "coffee", "tea", "rum", "sake", "show", "live", "music",
])
const words = (s) =>
    String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP.has(w))
const weight = (w) => (GENERIC.has(w) ? 0.3 : 1)
function nameMatch(query, name) {
    const want = words(String(query).split(",")[0])
    if (!want.length) return 0
    const got = new Set(words(name))
    const total = want.reduce((a, w) => a + weight(w), 0)
    return want.filter((w) => got.has(w)).reduce((a, w) => a + weight(w), 0) / total
}
const MAX_QUERIES = 40
const MAX_QUERY_LEN = 200
const CONCURRENCY = 8

async function lookup(query) {
    const hit = cache.get(query)
    if (hit && Date.now() - hit.ts < TTL) return hit.v

    let out = {}
    try {
        const r = await fetch(
            "https://places.googleapis.com/v1/places:searchText",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": KEY,
                    "X-Goog-FieldMask":
                        "places.websiteUri,places.googleMapsUri,places.displayName,places.types,places.primaryType,places.addressComponents,places.priceLevel",
                },
                body: JSON.stringify({ textQuery: query, pageSize: 1 }),
            }
        )
        const data = await r.json()

        // Unlike place-photo.js, do NOT swallow this silently. A dead key or a
        // lapsed billing account looked identical to "no result" there, and it
        // cost an afternoon to find.
        if (data?.error) {
            console.error(
                `[place-link] Places error ${data.error.code} ${data.error.status}: ${data.error.message}`
            )
            return {} // not cached - so it retries once the account is fixed
        }

        const p = data?.places?.[0]
        const same = p ? nameMatch(query, p?.displayName?.text) >= 0.5 : false
        if (p) out.match = same
        // Only the place we asked about gives us a website, a type or an
        // area. A different place's would be wrong, not just unhelpful.
        if (p && same) {
            if (typeof p.websiteUri === "string" && p.websiteUri)
                out.website = p.websiteUri
            if (typeof p.googleMapsUri === "string" && p.googleMapsUri)
                out.maps = p.googleMapsUri
            // Google lists it as free to visit (museums, parks, churches): the
            // card can say "Free" instead of "Price not confirmed".
            if (p.priceLevel === "PRICE_LEVEL_FREE") out.free = true
            // Only said when Google found the place AND told us its types.
            // Nothing found (an Airbnb flat, say) leaves it out: unknown, not "no".
            const types = [
                ...(Array.isArray(p.types) ? p.types : []),
                ...(typeof p.primaryType === "string" ? [p.primaryType] : []),
            ]
            if (types.length) out.lodging = types.some((t) => LODGING.has(t))
            // The neighbourhood Google files it under, for the card's area
            // label (the model's guess was sometimes the wrong district).
            const comps = Array.isArray(p.addressComponents) ? p.addressComponents : []
            const pick = (t) => comps.find((c) => Array.isArray(c?.types) && c.types.includes(t))
            const clean = (c) =>
                String(c?.longText || c?.shortText || "")
                    .replace(/\s+(Ward|District|Borough)$/i, "")
                    .replace(/-ku$/i, "")
                    .trim()
            // Numbered districts ("8e Arrondissement", "1 Chome") say less than
            // the model's "Le Marais", so they are skipped.
            const named = (c) => {
                const t = clean(c)
                return t && !/\d/.test(t) && t.length <= 30 ? t : ""
            }
            // Town names are left out: Google gives the local spelling
            // ("Lisboa" on a Lisbon trip), which reads as a different place.
            const area =
                named(pick("neighborhood")) ||
                named(pick("sublocality_level_1")) ||
                named(pick("sublocality"))
            if (area) out.area = area
        }
    } catch (err) {
        console.error("[place-link] lookup failed", err)
        return {} // transient - don't poison the cache
    }

    // A genuine "no website on file" IS cached, so we stop asking for it.
    cache.set(query, { v: out, ts: Date.now() })
    return out
}

async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).end()

    if (!KEY) {
        console.error("[place-link] GOOGLE_PLACES_API_KEY is not set")
        return res.status(200).json({ results: {} }) // degrade, don't break Book It
    }

    const raw = req.body?.queries
    if (!Array.isArray(raw)) {
        return res.status(400).json({ error: "queries must be an array" })
    }

    const queries = [
        ...new Set(
            raw
                .filter((q) => typeof q === "string")
                .map((q) => q.trim().slice(0, MAX_QUERY_LEN))
                .filter(Boolean)
        ),
    ].slice(0, MAX_QUERIES)

    if (!queries.length) return res.status(200).json({ results: {} })

    const results = {}
    for (let i = 0; i < queries.length; i += CONCURRENCY) {
        const batch = queries.slice(i, i + CONCURRENCY)
        const settled = await Promise.all(
            batch.map(async (q) => [q, await lookup(q)])
        )
        for (const [q, v] of settled) results[q] = v
    }

    return res.status(200).json({ results })
}

export default withGuard(handler, {
    prefix: "place-link",
    // One batched call per trip page view, so this is generous for a human and
    // tight for a script. Each call can fan out to MAX_QUERIES Places lookups.
    limit: 20,
    windowSec: 60,
    dailyCap: 2000,
})
