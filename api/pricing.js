// api/pricing.js
export const maxDuration = 30

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN

// Fetch + parse safely. Never throws — returns status + parsed json (or null)
// + a short snippet of the body so we can see HTML error pages.
async function safeGet(url) {
    try {
        const r = await fetch(url)
        const text = await r.text()
        let json = null
        try {
            json = JSON.parse(text)
        } catch {
            /* non-JSON (e.g. an HTML error page) */
        }
        return { ok: r.ok, status: r.status, json, snippet: text.slice(0, 140) }
    } catch (e) {
        return { ok: false, status: 0, json: null, snippet: String(e.message) }
    }
}

async function getFlight({ origin, destination, departureDate, returnDate }) {
    if (!origin || !destination || !departureDate)
        return { result: { found: false }, debug: { skipped: "missing args" } }
    const params = new URLSearchParams({
        origin,
        destination,
        departure_at: departureDate,
        ...(returnDate ? { return_at: returnDate } : {}),
        currency: "usd",
        sorting: "price",
        direct: "false",
        limit: "30",
        page: "1",
        one_way: returnDate ? "false" : "true",
        token: TOKEN,
    })
    const g = await safeGet(
        `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`
    )
    const debug = { status: g.status, snippet: g.json ? undefined : g.snippet }
    const arr = g.json?.data
    if (!Array.isArray(arr)) return { result: { found: false }, debug }
    const prices = arr
        .map((d) => d.price)
        .filter((n) => typeof n === "number" && n > 0)
        .sort((a, b) => a - b)
    if (!prices.length) return { result: { found: false }, debug }
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
    const params = new URLSearchParams({
        location: cityName,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        currency: "usd",
        limit: "30",
        token: TOKEN,
    })
    const g = await safeGet(
        `https://engine.hotellook.com/api/v2/cache.json?${params}`
    )
    const debug = { status: g.status, snippet: g.json ? undefined : g.snippet }
    const arr = g.json
    if (!Array.isArray(arr) || !arr.length)
        return { result: { found: false }, debug }
    const nights = Math.max(
        1,
        Math.round((new Date(checkOutDate) - new Date(checkInDate)) / 86400000)
    )
    const stayTotals = arr
        .map((h) => h.priceAvg ?? h.priceFrom)
        .filter((n) => typeof n === "number" && n > 0)
        .sort((a, b) => a - b)
    if (!stayTotals.length) return { result: { found: false }, debug }
    const medianTotal = stayTotals[Math.floor(stayTotals.length / 2)]
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
