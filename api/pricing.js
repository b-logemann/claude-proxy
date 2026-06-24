// api/pricing.js
export const maxDuration = 30

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN
const SERPAPI_KEY = process.env.SERPAPI_KEY

async function safeGet(url) {
    try {
        const r = await fetch(url)
        const text = await r.text()
        let json = null
        try {
            json = JSON.parse(text)
        } catch {}
        return { ok: r.ok, status: r.status, json, snippet: text.slice(0, 160) }
    } catch (e) {
        return { ok: false, status: 0, json: null, snippet: String(e.message) }
    }
}

// Flights — Travelpayouts (Aviasales), month granularity, per-person price.
async function getFlight({ origin, destination, departureDate, returnDate }) {
    if (!origin || !destination || !departureDate)
        return { result: { found: false }, debug: { skipped: "missing args" } }
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
    } else debug.snippet = g.snippet
    const arr = g.json?.data
    if (!Array.isArray(arr) || !arr.length) return { result: { found: false }, debug }
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

// Hotels — SerpApi Google Hotels. rate_per_night is per room; per-person ÷2.
async function getHotel({ cityName, checkInDate, checkOutDate }) {
    if (!cityName || !checkInDate || !checkOutDate)
        return { result: { found: false }, debug: { skipped: "missing args" } }
    if (!SERPAPI_KEY)
        return {
            result: { found: false },
            debug: { error: "SERPAPI_KEY not set" },
        }
    const nights = Math.max(
        1,
        Math.round((new Date(checkOutDate) - new Date(checkInDate)) / 86400000)
    )
    const params = new URLSearchParams({
        engine: "google_hotels",
        q: `${cityName} hotels`,
        check_in_date: checkInDate,
        check_out_date: checkOutDate,
        adults: "2",
        currency: "USD",
        gl: "us",
        hl: "en",
        api_key: SERPAPI_KEY,
    })
    const g = await safeGet(`https://serpapi.com/search.json?${params}`)
    const debug = {
        status: g.status,
        error: g.json?.error,
        snippet: g.json ? undefined : g.snippet,
    }
    const props = g.json?.properties
    if (!Array.isArray(props) || !props.length)
        return { result: { found: false }, debug }
    const nightlies = props
        .map((p) => p.rate_per_night?.extracted_lowest)
        .filter((n) => typeof n === "number" && n > 0)
        .sort((a, b) => a - b)
    if (!nightlies.length) return { result: { found: false }, debug }
    const medianNightly = nightlies[Math.floor(nightlies.length / 2)]
    return {
        result: {
            found: true,
            nights,
            perNightPerRoom: Math.round(medianNightly),
            perPersonTotal: Math.round((medianNightly * nights) / 2), // double occupancy
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
