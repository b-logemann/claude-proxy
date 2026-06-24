// api/pricing.js
export const maxDuration = 30

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN

// Flights — Aviasales "prices for dates". price is per passenger.
async function getFlight({ origin, destination, departureDate, returnDate }) {
    if (!origin || !destination || !departureDate) return { found: false }
    const params = new URLSearchParams({
        origin,
        destination,
        departure_at: departureDate, // "YYYY-MM-DD" or "YYYY-MM"
        ...(returnDate ? { return_at: returnDate } : {}),
        currency: "usd",
        sorting: "price",
        direct: "false",
        limit: "30",
        page: "1",
        one_way: returnDate ? "false" : "true",
        token: TOKEN,
    })
    const r = await fetch(
        `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`
    )
    const data = await r.json()
    if (!data?.success || !Array.isArray(data.data)) return { found: false }
    const prices = data.data
        .map((d) => d.price)
        .filter((n) => typeof n === "number" && n > 0)
        .sort((a, b) => a - b)
    if (!prices.length) return { found: false }
    return {
        found: true,
        cheapestPerPerson: Math.round(prices[0]),
        typicalPerPerson: Math.round(prices[Math.floor(prices.length / 2)]),
    }
}

// Hotels — Hotellook cache. priceAvg/priceFrom = avg/min for the stay (per room).
async function getHotel({ cityName, checkInDate, checkOutDate }) {
    if (!cityName || !checkInDate || !checkOutDate) return { found: false }
    const params = new URLSearchParams({
        location: cityName,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        currency: "usd",
        limit: "30",
        token: TOKEN,
    })
    const r = await fetch(
        `https://engine.hotellook.com/api/v2/cache.json?${params}`
    )
    const data = await r.json()
    if (!Array.isArray(data) || !data.length) return { found: false }
    const nights = Math.max(
        1,
        Math.round((new Date(checkOutDate) - new Date(checkInDate)) / 86400000)
    )
    const stayTotals = data
        .map((h) => h.priceAvg ?? h.priceFrom)
        .filter((n) => typeof n === "number" && n > 0)
        .sort((a, b) => a - b)
    if (!stayTotals.length) return { found: false }
    const medianTotal = stayTotals[Math.floor(stayTotals.length / 2)] // full stay, 1 room
    return {
        found: true,
        nights,
        perNightPerRoom: Math.round(medianTotal / nights),
        perPersonTotal: Math.round(medianTotal / 2), // double occupancy
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
            origin, // flight origin IATA, e.g. "JFK"
            destination, // flight destination IATA, e.g. "ROM"
            cityName, // hotel city name, e.g. "Rome"
            departureDate,
            returnDate,
            checkInDate,
            checkOutDate,
        } = req.body || {}

        const [flight, hotel] = await Promise.all([
            getFlight({ origin, destination, departureDate, returnDate }),
            getHotel({ cityName, checkInDate, checkOutDate }),
        ])
        return res.status(200).json({ currency: "USD", flight, hotel })
    } catch (err) {
        return res.status(500).json({ error: err.message })
    }
}
