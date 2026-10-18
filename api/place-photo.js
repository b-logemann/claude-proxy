// Returns a real venue photo via Google Places (New). Looks the place up by
// text query, resolves its first photo to a key-free googleusercontent URL,
// and 302-redirects the <img> straight to it. Cached in-memory per query to
// keep Places billing down across repeat loads (resets on cold start).
import { withGuard } from "./_guard.js"

const KEY = process.env.GOOGLE_PLACES_API_KEY
const cache = new Map() // query -> { url: string|null, ts: number }
const TTL = 1000 * 60 * 60 * 24 // 24h

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
                    "X-Goog-FieldMask": "places.photos,places.displayName",
                },
                body: JSON.stringify({ textQuery: query, pageSize: 1 }),
            }
        )
        const searchData = await searchRes.json()
        const photoName = searchData?.places?.[0]?.photos?.[0]?.name
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
