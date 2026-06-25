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

// City NAME or airport CODE → IATA code (Travelpayouts autocomplete, free).
const iataCache = {}
async function lookupCode(q) {
    if (!q) return null
    const g = await safeGet(
        `https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(
            q
        )}&locale=en&types[]=city&types[]=airport`
    )
    const arr = Array.isArray(g.json) ? g.json : []
    const pick =
        arr.find((p) => p.type === "city" && p.code) ||
        arr.find((p) => p.code)
    return pick?.code || null
}
async function resolveIATA(term) {
    if (!term) return null
    const t = String(term).trim()
    if (/^[A-Za-z]{3}$/.test(t)) return t.toUpperCase()
    if (iataCache[t]) return iataCache[t]
    const q = t.split(",")[0].trim()
    let code = await lookupCode(q)
    if (!code && /\bcity\b/i.test(q))
        code = await lookupCode(q.replace(/\s*city\s*$/i, "").trim())
    if (code) iataCache[t] = code
    return code
}

// Real flight facts for one route via SerpApi Google Flights.
async function routeInfo(depCode, arrCode, depMonth, retMonth) {
    if (!depCode || !arrCode || !depMonth)
        return { found: false, reason: "missing codes" }
    const params = new URLSearchParams({
        engine: "google_flights",
        departure_id: depCode,
        arrival_id: arrCode,
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
        const originCode = await resolveIATA(origin)

        const results = await Promise.all(
            candidates.map(async (c) => {
                const destinationCode = await resolveIATA(c?.destination)
                return {
                    id: c?.id,
                    destination: c?.destination,
                    originCode,
                    destinationCode,
                    ...(await routeInfo(
                        originCode,
                        destinationCode,
                        depMonth,
                        retMonth
                    )),
                }
            })
        )
        return res.status(200).json({ originCode, results })
    } catch (err) {
        return res.status(500).json({ error: err.message })
    }
}
