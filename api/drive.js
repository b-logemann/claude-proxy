// api/drive.js — Tier 1 driving feasibility for The Away Edit.
// Given an origin + candidate destinations, returns driving time, distance, and
// a rough round-trip fuel estimate per car, mirroring /api/feasibility (flights).
// Per-person math is done client-side (it knows the group size).

const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY

// Tunable fuel assumptions (US averages). Change in one place.
const MPG = 25
const FUEL_PRICE_PER_GALLON = 3.5

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

export default async function handler(req, res) {
    setCors(res)
    if (req.method === "OPTIONS") return res.status(200).end()
    if (req.method !== "POST")
        return res.status(405).json({ error: "Method not allowed" })

    try {
        if (!GOOGLE_KEY)
            return res.status(500).json({ error: "Missing GOOGLE_MAPS_KEY" })

        const { origin, candidates } = req.body || {}
        if (!origin || !Array.isArray(candidates) || candidates.length === 0)
            return res
                .status(400)
                .json({ error: "origin and candidates[] are required" })

        // 1 origin × N destinations — well within Distance Matrix limits.
        const destParam = candidates
            .map((c) => encodeURIComponent(c.destination))
            .join("|")
        const url =
            "https://maps.googleapis.com/maps/api/distancematrix/json" +
            `?origins=${encodeURIComponent(origin)}` +
            `&destinations=${destParam}` +
            `&mode=driving&units=imperial&key=${GOOGLE_KEY}`

        const apiRes = await fetch(url)
        const data = await apiRes.json()
        const elements = data?.rows?.[0]?.elements || []

        const results = candidates.map((c, i) => {
            const el = elements[i]
            if (!el || el.status !== "OK") return { id: c.id, found: false }
            const miles = el.distance.value / 1609.34 // meters → miles
            const driveHours = el.duration.value / 3600 // seconds → hours
            const fuelCostTotal = Math.round(
                ((miles * 2) / MPG) * FUEL_PRICE_PER_GALLON // round-trip
            )
            return {
                id: c.id,
                found: true,
                driveHours: Math.round(driveHours * 10) / 10,
                miles: Math.round(miles),
                fuelCostTotal, // per vehicle, round-trip — divided per person client-side
            }
        })

        return res.status(200).json({ results })
    } catch (err) {
        return res
            .status(500)
            .json({ error: String((err && err.message) || err) })
    }
}
