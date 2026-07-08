// api/_guard.js — CORS allowlist + Upstash rate limiting for (req,res) handlers.
import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"

const ALLOWED_ORIGINS = new Set([
    "https://theawayedit.com",
    "https://www.theawayedit.com",
])
// Framer editor/preview — keep while building in Framer, remove to fully lock down.
const ALLOWED_SUFFIXES = [".framer.app", ".framer.website", ".framercanvas.com"]
// TEMPORARY — Framer editor/canvas origins for testing. Remove before launch.
const ALLOWED_EXACT_TEST = new Set([
    "https://framer.com",
    "https://www.framer.com",
])

function isAllowed(origin) {
    if (!origin) return false
    if (ALLOWED_ORIGINS.has(origin)) return true
    if (ALLOWED_EXACT_TEST.has(origin)) return true
    try {
        const host = new URL(origin).hostname
        return ALLOWED_SUFFIXES.some((s) => host.endsWith(s))
    } catch {
        return false
    }
}

function applyCors(req, res) {
    const origin = req.headers.origin
    const allow = isAllowed(origin) ? origin : "https://theawayedit.com"
    res.setHeader("Access-Control-Allow-Origin", allow)
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    res.setHeader("Vary", "Origin")
    return origin
}

// Only build limiters if the KV vars exist — otherwise rate limiting is skipped
// (CORS still applies) so nothing breaks before Upstash is wired.
const redis =
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
        ? new Redis({
              url: process.env.KV_REST_API_URL,
              token: process.env.KV_REST_API_TOKEN,
          })
        : null

const limiters = {}
function getLimiter(limit, windowSec, prefix) {
    if (!redis) return null
    const key = `${prefix}:${limit}:${windowSec}`
    if (!limiters[key])
        limiters[key] = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
            prefix: `rl:${prefix}`,
        })
    return limiters[key]
}

export function withGuard(handler, opts = {}) {
    const limit = opts.limit ?? 30
    const windowSec = opts.windowSec ?? 60
    const prefix = opts.prefix ?? "general"

    return async function guarded(req, res) {
        const origin = applyCors(req, res)

        if (req.method === "OPTIONS") return res.status(204).end()

        // Block browser calls from disallowed origins. Requests with no Origin
        // (server-to-server, curl) pass through — tighten if you want.
        if (origin && !isAllowed(origin))
            return res.status(403).json({ error: "Origin not allowed" })

        const limiter = getLimiter(limit, windowSec, prefix)
        if (limiter) {
            const ip =
                (req.headers["x-forwarded-for"] || "")
                    .split(",")[0]
                    .trim() ||
                req.headers["x-real-ip"] ||
                "unknown"
            const { success, reset } = await limiter.limit(ip)
            if (!success) {
                res.setHeader(
                    "Retry-After",
                    String(Math.ceil((reset - Date.now()) / 1000))
                )
                return res
                    .status(429)
                    .json({ error: "Too many requests. Please slow down." })
            }
        }

        return handler(req, res)
    }
}
