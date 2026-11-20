// Anonymous funnel counts for The Away Edit (Nov 2026).
//
// The page POSTs {"e": "<event>"} at a few moments (questions started, trip
// built, emailed...). Each one adds 1 to a per-day counter in the same Upstash
// Redis the rate limiter uses. Nothing else is stored: no IP, no cookie, no
// ID, nothing about the trip. Counters expire after 400 days.
//
// Read them at /api/stats?key=<STATS_KEY>.
import { Redis } from "@upstash/redis"
import { withGuard } from "./_guard.js"

const EVENTS = new Set([
    "intake_start",
    "intake_done",
    "options_shown",
    "place_chosen",
    "itin_built",
    "itin_failed",
    "pair_answered",
    "ask_sent",
    "trim_used",
    "book_click",
    "email_sent",
    "pdf_saved",
    "new_trip",
])

const redis =
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
        ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
        : null

const TTL = 60 * 60 * 24 * 400

async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).end()
    let body = req.body
    if (typeof body === "string") {
        try {
            body = JSON.parse(body)
        } catch {
            body = null
        }
    }
    const e = String(body?.e || "")
    if (!EVENTS.has(e)) return res.status(400).end()
    if (!redis) return res.status(204).end()
    try {
        const day = new Date().toISOString().slice(0, 10)
        const key = `ae:stat:${day}`
        await redis.hincrby(key, e, 1)
        await redis.expire(key, TTL)
    } catch (err) {
        console.error("[track] redis failed", err)
    }
    return res.status(204).end()
}

// Same origin rules as the other POST endpoints, so only the site can count.
// A Redis outage must never matter to the page, hence requireLimiter: false.
export default withGuard(handler, {
    prefix: "track",
    limit: 60,
    windowSec: 60,
    dailyCap: 20000,
    requireOrigin: true,
    requireLimiter: false,
})
