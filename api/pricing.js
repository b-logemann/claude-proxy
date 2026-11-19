// api/pricing.js
import { withGuard } from "./_guard.js"

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

// -- Named stays (Nov 2026) --------------------------------------------------
// The trip page names three hotels (Comfortable / A step up / Treat yourselves)
// and their prices came from the model. This looks each one up by name on
// Google Hotels for the real dates and returns its own nightly rate, or
// nothing - and nothing means the page keeps saying "estimate".
// Cost: one SerpApi search per hotel (3 per trip), cached for 12 hours.

const stayCache = new Map() // key -> { v, ts }
const STAY_TTL = 1000 * 60 * 60 * 12
const MAX_STAYS = 3

const norm = (s) =>
    String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w && !["hotel", "the", "le", "la", "de", "du", "and", "by", "a"].includes(w))

// Same place? Most of the words in the name we asked for appear in Google's.
function sameName(asked, got) {
    const a = norm(asked)
    const b = new Set(norm(got))
    if (!a.length || !b.size) return false
    const hit = a.filter((w) => b.has(w)).length
    return hit / a.length >= 0.6
}

function rateOf(p) {
    const n = p?.rate_per_night?.extracted_lowest
    return typeof n === "number" && n > 0 ? n : null
}

async function getNamedStay({ name, cityName, checkInDate, checkOutDate, adults }) {
    const key = [name, cityName, checkInDate, checkOutDate, adults].join("|").toLowerCase()
    const hit = stayCache.get(key)
    if (hit && Date.now() - hit.ts < STAY_TTL) return hit.v
    const params = new URLSearchParams({
        engine: "google_hotels",
        q: `${name}, ${cityName}`,
        check_in_date: checkInDate,
        check_out_date: checkOutDate,
        adults: String(adults),
        currency: "USD",
        gl: "us",
        hl: "en",
        api_key: SERPAPI_KEY,
    })
    const g = await safeGet(`https://serpapi.com/search.json?${params}`)
    if (!g.json || g.json.error) {
        console.error("[pricing] stay lookup", g.status, g.json?.error || g.snippet)
        return { found: false } // not cached: a quota or key problem should retry
    }
    // A query that names one hotel often lands on that hotel's own page
    // (fields at the top level); otherwise look through the list.
    const candidates = [
        ...(g.json.name ? [g.json] : []),
        ...(Array.isArray(g.json.properties) ? g.json.properties : []),
    ]
    const p = candidates.find((c) => sameName(name, c?.name) && rateOf(c))
    const v = p
        ? {
              found: true,
              name: p.name,
              perNightPerRoom: Math.round(rateOf(p)),
              link: typeof p.link === "string" ? p.link : undefined,
          }
        : { found: false }
    stayCache.set(key, { v, ts: Date.now() })
    return v
}

async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).end()

    // Named-stay mode: { stays: ["Hotel A", ...], cityName, checkInDate, checkOutDate, people }
    if (Array.isArray(req.body?.stays)) {
        const { cityName, checkInDate, checkOutDate } = req.body
        const people = Math.max(1, Math.min(30, Number(req.body.people) || 2))
        const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))
        if (!SERPAPI_KEY || !cityName || !okDate(checkInDate) || !okDate(checkOutDate))
            return res.status(200).json({ stays: {} })
        const names = [
            ...new Set(
                req.body.stays
                    .filter((s) => typeof s === "string")
                    .map((s) => s.trim().slice(0, 120))
                    .filter(Boolean)
            ),
        ].slice(0, MAX_STAYS)
        // Google prices a room; two people to a room, so a party of four is
        // two rooms (the page multiplies).
        const adults = Math.min(2, people)
        const out = {}
        await Promise.all(
            names.map(async (n) => {
                try {
                    out[n] = await getNamedStay({
                        name: n,
                        cityName: String(cityName).slice(0, 80),
                        checkInDate,
                        checkOutDate,
                        adults,
                    })
                } catch (e) {
                    out[n] = { found: false }
                }
            })
        )
        return res.status(200).json({ stays: out, rooms: Math.ceil(people / 2) })
    }

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
            // Upstream error text stays in the logs, not in the browser.
            ...(process.env.PRICING_DEBUG === "1"
                ? { _debug: { flight: flight.debug, hotel: hotel.debug } }
                : {}),
        })
    } catch (err) {
        console.error("[pricing]", err)
        return res.status(500).json({ error: "Pricing unavailable" })
    }
}

export default withGuard(handler, { prefix: "pricing" })
