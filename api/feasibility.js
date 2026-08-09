// api/feasibility.js
import { withGuard } from "./_guard.js"
export const maxDuration = 30
const SERPAPI_KEY = process.env.SERPAPI_KEY
async function safeGet(url) {
    try {
        const r = await fetch(url)
        const t = await r.text()
        let j = null
        try {
            j = JSON.parse(t)
        } catch {}
        return { status: r.status, json: j, snippet: t.slice(0, 140) }
    } catch (e) {
        return { status: 0, json: null, snippet: String(e.message) }
    }
}
// City NAME → comma-joined AIRPORT codes (e.g. "New York" → "JFK,EWR,LGA").
// Google Flights needs airport codes, not metro codes, so we prefer airports.
const codeCache = {}
async function airportsFor(q) {
    const g = await safeGet(
        `https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(
            q
        )}&locale=en&types[]=airport`
    )
    const arr = Array.isArray(g.json) ? g.json : []
    const airports = [
        ...new Set(arr.filter((p) => p.code).map((p) => p.code)),
    ].slice(0, 3)
    if (airports.length) return airports
    const g2 = await safeGet(
        `https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(
            q
        )}&locale=en&types[]=city`
    )
    const arr2 = Array.isArray(g2.json) ? g2.json : []
    const city = arr2.find((p) => p.code)
    return city ? [city.code] : []
}
async function resolveCodes(term) {
    if (!term) return null
    const t = String(term).trim()
    if (/^[A-Za-z]{3}$/.test(t)) return t.toUpperCase() // already an airport code
    if (codeCache[t]) return codeCache[t]
    const q = t.split(",")[0].trim()
    let codes = await airportsFor(q)
    if (!codes.length && /\bcity\b/i.test(q))
        codes = await airportsFor(q.replace(/\s*city\s*$/i, "").trim())
    const joined = codes.length ? codes.join(",") : null
    if (joined) codeCache[t] = joined
    return joined
}
async function routeInfo(depCodes, arrCodes, depMonth, retMonth) {
    if (!depCodes || !arrCodes || !depMonth)
        return { found: false, reason: "missing codes" }
    const params = new URLSearchParams({
        engine: "google_flights",
        departure_id: depCodes,
        arrival_id: arrCodes,
        outbound_date: `${depMonth}-15`,
        ...(retMonth ? { return_date: `${retMonth}-18` } : {}),
        currency: "USD",
        type: retMonth ? "1" : "2",
        hl: "en",
        api_key: SERPAPI_KEY,
    })
    const g = await safeGet(`https://serpapi.com/search.json?${params}`)
    if (g.json?.error) return { found: false, error: g.json.error }
    const best = Array.isArray(g.json?.best_flights) ? g.json.best_flights : []
    const other = Array.isArray(g.json?.other_flights)
        ? g.json.other_flights
        : []
    // Price ONLY from Google's curated "best" itineraries when available. The
    // "other" bucket occasionally holds anomalous/partial fares that surface as
    // impossibly-low prices (e.g. a $222 round-trip to Hawaii). Fall back to
    // "other" only when there are no "best" flights at all.
    const pricePool = (best.length ? best : other).filter(
        (f) => typeof f.price === "number" && f.price > 0
    )
    if (!pricePool.length) return { found: false, status: g.status }
    const cheapest = [...pricePool].sort((a, b) => a.price - b.price)[0]
    // "Fastest" can still consider every returned itinerary.
    const allFlights = [...best, ...other]
    const durations = allFlights
        .map((f) => f.total_duration)
        .filter((n) => typeof n === "number" && n > 0)
    const fastestMin = durations.length ? Math.min(...durations) : null
    const stopsOf = (f) =>
        Array.isArray(f.flights) ? f.flights.length - 1 : null
    return {
        found: true,
        cheapestPrice: Math.round(cheapest.price),
        cheapestStops: stopsOf(cheapest),
        cheapestHours:
            typeof cheapest.total_duration === "number"
                ? +(cheapest.total_duration / 60).toFixed(1)
                : null,
        fastestHours: fastestMin != null ? +(fastestMin / 60).toFixed(1) : null,
    }
}
async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).end()
    if (!SERPAPI_KEY)
        return res.status(500).json({ error: "SERPAPI_KEY not set" })
    try {
        const { origin, candidates = [], departureDate, returnDate } =
            req.body || {}
        const depMonth = departureDate ? String(departureDate).slice(0, 7) : null
        const retMonth = returnDate ? String(returnDate).slice(0, 7) : null
        const originCodes = await resolveCodes(origin)
        const results = await Promise.all(
            candidates.map(async (c) => {
                // Prefer the airport code the caller already provides (Claude
                // returns one per destination). This skips the slow Travelpayouts
                // lookups that were making this function time out on multi-city
                // international searches — which surfaced as "Failed to fetch".
                const provided =
                    c?.destinationIATA &&
                    /^[A-Za-z]{3}$/.test(String(c.destinationIATA).trim())
                        ? String(c.destinationIATA).trim().toUpperCase()
                        : null
                const destinationCodes =
                    provided || (await resolveCodes(c?.destination))
                return {
                    id: c?.id,
                    destination: c?.destination,
                    originCodes,
                    destinationCodes,
                    ...(await routeInfo(
                        originCodes,
                        destinationCodes,
                        depMonth,
                        retMonth
                    )),
                }
            })
        )
        return res.status(200).json({ originCodes, results })
    } catch (err) {
        return res.status(500).json({ error: err.message })
    }
}
export default withGuard(handler, { prefix: "feasibility" })
