// api/feasibility.js
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
    const flights = [
        ...(Array.isArray(g.json?.best_flights) ? g.json.best_flights : []),
        ...(Array.isArray(g.json?.other_flights) ? g.json.other_flights : []),
    ]
    if (!flights.length) return { found: false, status: g.status }
    const priced = flights.filter(
        (f) => typeof f.price === "number" && f.price > 0
    )
    const cheapest = priced.sort((a, b) => a.price - b.price)[0] || flights[0]
    const durations = flights
        .map((f) => f.total_duration)
        .filter((n) => typeof n === "number" && n > 0)
    const fastestMin = durations.length ? Math.min(...durations) : null
    const stopsOf = (f) => (Array.isArray(f.flights) ? f.flights.length - 1 : null)
    return {
        found: true,
        cheapestPrice:
            typeof cheapest?.price === "number"
                ? Math.round(cheapest.price)
                : null,
        cheapestStops: stopsOf(cheapest),
        cheapestHours:
            typeof cheapest?.total_duration === "number"
                ? +(cheapest.total_duration / 60).toFixed(1)
                : null,
        fastestHours: fastestMin != null ? +(fastestMin / 60).toFixed(1) : null,
    }
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") return res.status(200).end()
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
                const destinationCodes = await resolveCodes(c?.destination)
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
