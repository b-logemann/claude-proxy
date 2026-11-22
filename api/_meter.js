// api/_meter.js - daily usage counters for the stats page (Nov 2026).
//
// Each paid call adds to one per-day Redis hash, ae:meter:YYYY-MM-DD (UTC):
//   claude_in:<model> / claude_out:<model>   tokens sent and received
//   places_text_ent   Google Text Search, Enterprise fields (place-link)
//   places_text_pro   Google Text Search, Pro fields (place-photo)
//   places_photo      Google Place Photo lookups (place-photo)
//   serpapi           SerpApi searches (pricing)
//   email_sent / email_failed                  Resend
//   call:<endpoint>   requests that passed the guard
//   block_*:<endpoint> requests the guard turned away
//   err:<what>        upstream failures
//
// Only counts: no IP, no ID, nothing about the visitor or the trip. Expires
// after 400 days. Read by /api/stats.
//
// A meter must never cost the visitor anything: every failure is swallowed,
// and with no Redis configured it does nothing.
import { Redis } from "@upstash/redis"

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null

export const redis = URL && TOKEN ? new Redis({ url: URL, token: TOKEN }) : null

const TTL = 60 * 60 * 24 * 400

export const meterKey = (day) => `ae:meter:${day}`
export const today = () => new Date().toISOString().slice(0, 10)

// meter({ serpapi: 1 }) or meter({ "claude_in:claude-sonnet-4-6": 5120, ... })
export async function meter(counts) {
    if (!redis || !counts) return
    try {
        const entries = Object.entries(counts).filter(([, v]) => Number(v) > 0)
        if (!entries.length) return
        const key = meterKey(today())
        const p = redis.pipeline()
        entries.forEach(([k, v]) => p.hincrby(key, k, Math.round(Number(v))))
        p.expire(key, TTL)
        await p.exec()
    } catch (err) {
        console.error("[meter] failed", err?.message || err)
    }
}

// Anthropic's response.usage -> token counters for that model.
export function claudeUsage(model, usage) {
    if (!usage) return {}
    const input =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0)
    return {
        [`claude_in:${model}`]: input,
        [`claude_out:${model}`]: Number(usage.output_tokens) || 0,
    }
}
