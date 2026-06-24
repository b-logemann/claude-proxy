// api/feasibility.js
export const maxDuration = 30

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN

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

// Real flight facts for one route (origin → destination IATA), month-level.
async function routeInfo(origin, destination, depMonth, retMonth) {
    if (!origin || !destination || !depMonth)
        return { found: false, reason: "missing args" }
    const params = new URLSearchParams({
        origin,
        destination,
        departure_at: depMonth,
        ...(retMonth ? { return_at: retMonth } : {}),
        currency: "usd",
        sorting: "price",
        direct: "false",
        limit: "30",
        page: "1",
        one_way: retMonth ? "false" : "true",
        token: TOKEN,
    })
    const g = await safeGet(
        `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`
    )
    const arr = Array.isArray(g.json?.data) ? g.json.data : []
    const priced = arr.filter((o) => typeof o.price === "number" && o.price > 0)
    if (!priced.length) return { found: false, status: g.status }

    const cheapest = [...priced].sort((a, b) => a.price - b.price)[0]
    const durs = arr
        .map((o) => o.duration_to) // one-way minutes, INCLUDING layovers
        .filter((n) => typeof n === "number" && n > 0)
    const fastestMin = durs.length ? Math.min(...durs) : null

    return {
        found: true,
        cheapestPrice: Math.round(cheapest.price),
        cheapestStops:
            typeof cheapest.transfers === "number" ? cheapest.transfers : null,
        cheapestHours:
            typeof cheapest.duration_to === "number"
                ? +(cheapest.duration_to / 60).toFixed(1)
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
    if (!TOKEN)
        return res.status(500).json({ error: "TRAVELPAYOUTS_TOKEN not set" })

    try {
        const { origin, candidates = [], departureDate, returnDate } =
            req.body || {}
        const depMonth = departureDate ? String(departureDate).slice(0, 7) : null
        const retMonth = returnDate ? String(returnDate).slice(0, 7) : null

        const results = await Promise.all(
            candidates.map(async (c) => ({
                id: c?.id,
                destination: c?.destination,
                ...(await routeInfo(origin, c?.destination, depMonth, retMonth)),
            }))
        )
        return res.status(200).json({ results })
    } catch (err) {
        return res.status(500).json({ error: err.message })
    }
}
