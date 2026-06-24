// api/pricing.js
export const maxDuration = 30

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN

async function safeGet(url) {
    try {
        const r = await fetch(url)
        const text = await r.text()
        let json = null
        try {
            json = JSON.parse(text)
        } catch {}
        return { ok: r.ok, status: r.status, json, snippet: text.slice(0, 140) }
    } catch (e) {
        return { ok: false, status: 0, json: null, snippet: String(e.message) }
    }
}

async function getFlight({ origin, destination, departureDate, returnDate }) {
    if (!origin || !destination || !departureDate)
        return { result: { found: false }, debug: { skipped: "missing args" } }

    // Travelpayouts wants MONTH granularity (YYYY-MM), not an exact date.
    const depMonth = String(departureDate).slice(0, 7)
    const retMonth = returnDate ? String(returnDate).slice(0, 7) : null

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
    const debug = { status: g.status }
    if (g.json) {
        debug.success = g.json.success
        debug.dataLen = Array.isArray(g.json.data) ? g.json.data.length : null
        if (g.json.error) debug.error = g.json.error
    } else debug.snippet = g.snippet

    const arr = g.json?.data
    if (!Array.isArray(arr) || !arr.length) return { result: { found: false }, debug }
    const prices = arr
        .map((d) => d.price)
        .filter((n) => typeof n === "number" && n > 0)
        .sort((a, b) => a - b)
    if (!prices.length) return { result: { found: false }, debug }
    debug.sample = prices[0]
    return {
        result: {
            found: true,
            cheapestPerPerson: Math.round(prices[0]),
            typicalPerPerson: Math.round(prices[Math.floor(prices.length / 2)]),
        },
        debug,
    }
}

async function getHotel({ cityName, checkInDate, checkOutDate }) {
    if (!cityName || !checkInDate || !checkOutDate)
        return { result: { found: false }, debug: { skipped: "missing args" } }
    const nights = Math.max(
        1,
        Math.round((new Date(checkOutDate) - new Date(checkInDate)) / 86400000)
    )
    // NOTE: endpoint below is retired (404). Awaiting current hotel URL.
    const g = await safeGet(
        `https://engine.hotellook.com/api/v2/cache.json?location=${encodeURIComponent(
            cityName
        )}&checkIn=${checkInDate}&checkOut=${checkOutDate}&currency=usd&limit=30&token=${TOKEN}`
    )
    const debug = { status: g.status, snippet: g.json ? undefined : g.snippet }
    const arr = Array.isArray(g.json) ? g.json : null
    if (!arr || !arr.length) return { result: { found: false }, debug }
    const totals = arr
        .map((h) => h.priceAvg ?? h.priceFrom)
        .filter((n) => typeof n === "number" && n > 0)
        .sort((a, b) => a - b)
    if (!totals.length) return { result: { found: false }, debug }
    const medianTotal = totals[Math.floor(totals.length / 2)]
    return {
        result: {
            found: true,
            nights,
            perNightPerRoom: Math.round(medianTotal / nights),
            perPersonTotal: Math.round(medianTotal / 2),
        },
        debug,
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
        const {
            origin,
            destination,
            cityName,
            departureDate,
            returnDate,
            checkInDate,
            checkOutDate,
        } = req.body || {}

        const flight = await getFlight({
            origin,
            destination,
            departureDate,
            returnDate,
        })
        const hotel = await getHotel({ cityName, checkInDate, checkOutDate })

        return res.status(200).json({
            currency: "USD",
            flight: flight.result,
            hotel: hotel.result,
            _debug: { flight: flight.debug, hotel: hotel.debug },
        })
    } catch (err) {
        return res.status(500).json({ error: err.message })
    }
}
