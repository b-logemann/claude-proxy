// api/place-link.js - resolves venues to their REAL website via Google Places.
//
// Why this exists: Book It was sending every restaurant to OpenTable/Resy and
// every experience to Viator + GetYourGuide, whether or not those platforms
// operate where the traveller is going. A hotel restaurant or a local guide is
// on none of them, so the link returned nothing. With affiliate earning off
// there is no reason to route through an aggregator at all - the venue's own
// site is simply the better answer.
//
// It deliberately does NOT ask the model for a URL. Claude will produce a
// perfectly-formed website for any venue you name and some fraction will be
// wrong - which is bugs #5, #8 and #10 in the rebuild notes, three times over.
// Places returns the website the business itself registered, or nothing.
//
// Batched on purpose: one request per trip page rather than ~25, so the
// component makes a single call and the fan-out happens here.
//
// COST NOTE: `websiteUri` sits in a more expensive Places billing tier than
// the fields place-photo.js requests. The cache below and the dailyCap in the
// guard are what keep that bounded. Watch it against the budget alert.

import { withGuard } from "./_guard.js"

export const maxDuration = 30

const KEY = process.env.GOOGLE_PLACES_API_KEY

const cache = new Map() // query -> { v: {website?, maps?}, ts: number }
const TTL = 1000 * 60 * 60 * 24 // 24h
const MAX_QUERIES = 40
const MAX_QUERY_LEN = 200
const CONCURRENCY = 8

async function lookup(query) {
    const hit = cache.get(query)
    if (hit && Date.now() - hit.ts < TTL) return hit.v

    let out = {}
    try {
        const r = await fetch(
            "https://places.googleapis.com/v1/places:searchText",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": KEY,
                    "X-Goog-FieldMask":
                        "places.websiteUri,places.googleMapsUri,places.displayName",
                },
                body: JSON.stringify({ textQuery: query, pageSize: 1 }),
            }
        )
        const data = await r.json()

        // Unlike place-photo.js, do NOT swallow this silently. A dead key or a
        // lapsed billing account looked identical to "no result" there, and it
        // cost an afternoon to find.
        if (data?.error) {
            console.error(
                `[place-link] Places error ${data.error.code} ${data.error.status}: ${data.error.message}`
            )
            return {} // not cached - so it retries once the account is fixed
        }

        const p = data?.places?.[0]
        if (p) {
            if (typeof p.websiteUri === "string" && p.websiteUri)
                out.website = p.websiteUri
            if (typeof p.googleMapsUri === "string" && p.googleMapsUri)
                out.maps = p.googleMapsUri
        }
    } catch (err) {
        console.error("[place-link] lookup failed", err)
        return {} // transient - don't poison the cache
    }

    // A genuine "no website on file" IS cached, so we stop asking for it.
    cache.set(query, { v: out, ts: Date.now() })
    return out
}

async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).end()

    if (!KEY) {
        console.error("[place-link] GOOGLE_PLACES_API_KEY is not set")
        return res.status(200).json({ results: {} }) // degrade, don't break Book It
    }

    const raw = req.body?.queries
    if (!Array.isArray(raw)) {
        return res.status(400).json({ error: "queries must be an array" })
    }

    const queries = [
        ...new Set(
            raw
                .filter((q) => typeof q === "string")
                .map((q) => q.trim().slice(0, MAX_QUERY_LEN))
                .filter(Boolean)
        ),
    ].slice(0, MAX_QUERIES)

    if (!queries.length) return res.status(200).json({ results: {} })

    const results = {}
    for (let i = 0; i < queries.length; i += CONCURRENCY) {
        const batch = queries.slice(i, i + CONCURRENCY)
        const settled = await Promise.all(
            batch.map(async (q) => [q, await lookup(q)])
        )
        for (const [q, v] of settled) results[q] = v
    }

    return res.status(200).json({ results })
}

export default withGuard(handler, {
    prefix: "place-link",
    // One batched call per trip page view, so this is generous for a human and
    // tight for a script. Each call can fan out to MAX_QUERIES Places lookups.
    limit: 20,
    windowSec: 60,
    dailyCap: 2000,
})
