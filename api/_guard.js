// api/_guard.js - CORS allowlist + Upstash rate limiting for (req,res) handlers.
//
// Changes from the previous version, in order of how much they matter:
//   1. Requests with no Origin header are now rejected by default. Previously
//      the allowlist only applied when an Origin was present, so any non-browser
//      client (curl, a script, a bot) bypassed it entirely. Image endpoints that
//      are loaded via <img src> must opt out with requireOrigin:false.
//   2. The origin === "null" exception is gone. It was there for double-clicked
//      file:// pages, but every sandboxed iframe on the internet also sends
//      Origin: null, so it allowed any site to call this proxy.
//   3. localhost is now allowed on preview/dev deployments only, never in
//      production. This keeps the local testing loop working without shipping
//      the hole.
//   4. Upstash env vars are read under both naming conventions (Vercel KV
//      integration vs direct Upstash), so a name mismatch can't silently
//      disable rate limiting.
//   5. Routes that spend money can require the limiter: if Redis is missing in
//      production they return 503 rather than quietly running unlimited.
//   6. Optional global daily cap per route - a circuit breaker that per-IP
//      limits cannot provide, because IP rotation is cheap.
//   7. Limiter calls are wrapped, so an Upstash outage no longer 500s every
//      endpoint at once.

import { Ratelimit } from "@upstash/ratelimit"
import { Redis } from "@upstash/redis"

const IS_PROD = process.env.VERCEL_ENV === "production"

const ALLOWED_ORIGINS = new Set([
    "https://theawayedit.com",
    "https://www.theawayedit.com",
])

// Framer editor, canvas and preview.
//
// NOTE: ".framer.app" / ".framer.website" is EVERY Framer-hosted site on the
// internet, not only yours - anyone can publish one. The rate limits below are
// what actually bounds that exposure; the allowlist does not. Set
// ALLOW_FRAMER_ORIGINS=false in the Vercel env once the site is live on
// theawayedit.com and you no longer need to hit the proxy from Framer preview.
const FRAMER_SUFFIXES = [".framer.app", ".framer.website", ".framercanvas.com"]
const FRAMER_EXACT = new Set(["https://framer.com", "https://www.framer.com"])
const ALLOW_FRAMER = process.env.ALLOW_FRAMER_ORIGINS !== "false"

function isAllowed(origin) {
    if (!origin) return false
    if (ALLOWED_ORIGINS.has(origin)) return true
    if (ALLOW_FRAMER && FRAMER_EXACT.has(origin)) return true

    let host
    try {
        host = new URL(origin).hostname
    } catch {
        return false
    }

    // Local testing - preview and dev deployments only. Never production.
    if (!IS_PROD && (host === "localhost" || host === "127.0.0.1")) return true

    if (ALLOW_FRAMER && FRAMER_SUFFIXES.some((s) => host.endsWith(s)))
        return true

    return false
}

function applyCors(req, res) {
    const origin = req.headers.origin
    const allow = isAllowed(origin) ? origin : "https://theawayedit.com"
    res.setHeader("Access-Control-Allow-Origin", allow)
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    res.setHeader("Access-Control-Max-Age", "86400")
    res.setHeader("Vary", "Origin")
    return origin
}

// Accept both naming conventions. The Vercel KV / Upstash marketplace
// integration sets KV_REST_API_*; a Redis database created directly in Upstash
// sets UPSTASH_REDIS_REST_*. Reading only one of them is how rate limiting ends
// up silently disabled in production.
const REDIS_URL =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null
const REDIS_TOKEN =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    null

const redis =
    REDIS_URL && REDIS_TOKEN
        ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
        : null

if (!redis) {
    console.warn(
        "[guard] No Upstash credentials found (KV_REST_API_URL/TOKEN or " +
            "UPSTASH_REDIS_REST_URL/TOKEN). Rate limiting is DISABLED."
    )
}

const limiters = {}
function getLimiter(limit, windowSec, prefix) {
    if (!redis) return null
    const key = `ip:${prefix}:${limit}:${windowSec}`
    if (!limiters[key])
        limiters[key] = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
            prefix: `rl:${prefix}`,
        })
    return limiters[key]
}

// Global ceiling across all callers. This is the only thing that survives IP
// rotation, so it is the real spend cap on the paid endpoints.
function getDailyCap(cap, prefix) {
    if (!redis || !cap) return null
    const key = `day:${prefix}:${cap}`
    if (!limiters[key])
        limiters[key] = new Ratelimit({
            redis,
            limiter: Ratelimit.fixedWindow(cap, "1 d"),
            prefix: `rlday:${prefix}`,
        })
    return limiters[key]
}

function clientIp(req) {
    const xff = req.headers["x-forwarded-for"]
    if (typeof xff === "string" && xff.length) {
        const first = xff.split(",")[0].trim()
        if (first) return first
    }
    return req.headers["x-real-ip"] || "unknown"
}

function tooMany(res, reset, message) {
    const secs = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
    res.setHeader("Retry-After", String(secs))
    return res.status(429).json({ error: message })
}

/**
 * withGuard(handler, opts)
 *
 *   limit          per-IP requests allowed per window.          default 30
 *   windowSec      length of that window in seconds.            default 60
 *   prefix         Redis key namespace. Give every route its
 *                  own, or they share one bucket.               default "general"
 *   dailyCap       total requests per day across ALL callers.
 *                  Omit for free endpoints; set it on anything
 *                  that spends money.                           default none
 *   requireOrigin  reject requests with no Origin header. Set
 *                  false ONLY for endpoints loaded via <img src>,
 *                  which send no Origin.                        default true
 *   requireLimiter in production, return 503 rather than run
 *                  unlimited when Redis is unavailable.         default true in prod
 */
export function withGuard(handler, opts = {}) {
    const limit = opts.limit ?? 30
    const windowSec = opts.windowSec ?? 60
    const prefix = opts.prefix ?? "general"
    const dailyCap = opts.dailyCap ?? null
    const requireOrigin = opts.requireOrigin !== false
    const requireLimiter = opts.requireLimiter ?? IS_PROD

    return async function guarded(req, res) {
        const origin = applyCors(req, res)

        if (req.method === "OPTIONS") return res.status(204).end()

        // An absent Origin is not a pass. Browsers always send one on a
        // cross-origin fetch, so legitimate calls from the site are unaffected;
        // what this blocks is curl and everything like it.
        if (!origin) {
            if (requireOrigin)
                return res.status(403).json({ error: "Origin required" })
        } else if (!isAllowed(origin)) {
            return res.status(403).json({ error: "Origin not allowed" })
        }

        if (!redis && requireLimiter) {
            console.error(
                `[guard] ${prefix}: refusing to serve - rate limiter unavailable`
            )
            return res
                .status(503)
                .json({ error: "Service temporarily unavailable" })
        }

        const ipLimiter = getLimiter(limit, windowSec, prefix)
        const capLimiter = getDailyCap(dailyCap, prefix)

        if (ipLimiter || capLimiter) {
            try {
                if (capLimiter) {
                    const g = await capLimiter.limit("global")
                    if (!g.success) {
                        console.error(
                            `[guard] ${prefix}: DAILY CAP of ${dailyCap} reached`
                        )
                        return tooMany(
                            res,
                            g.reset,
                            "This service is at capacity today. Please try again tomorrow."
                        )
                    }
                }

                if (ipLimiter) {
                    const r = await ipLimiter.limit(clientIp(req))
                    res.setHeader("X-RateLimit-Limit", String(r.limit))
                    res.setHeader(
                        "X-RateLimit-Remaining",
                        String(Math.max(0, r.remaining))
                    )
                    res.setHeader("X-RateLimit-Reset", String(r.reset))
                    if (!r.success)
                        return tooMany(
                            res,
                            r.reset,
                            "Too many requests. Please slow down."
                        )
                }
            } catch (err) {
                // An Upstash outage should not take down every endpoint at
                // once. Paid routes fail closed; free ones carry on.
                console.error(`[guard] ${prefix}: limiter error`, err)
                if (requireLimiter)
                    return res
                        .status(503)
                        .json({ error: "Service temporarily unavailable" })
            }
        }

        return handler(req, res)
    }
}
