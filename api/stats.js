// The funnel counts from /api/track, as a small table.
// Open https://claude-proxy-brown.vercel.app/api/stats?key=<STATS_KEY>
// (set STATS_KEY in Vercel -> Settings -> Environment Variables first).
// Add &days=90 for a longer window (default 30, max 400).
import { Redis } from "@upstash/redis"
import { withGuard } from "./_guard.js"

const ORDER = [
    ["intake_start", "Started the questions"],
    ["intake_done", "Finished the questions"],
    ["options_shown", "Saw place options"],
    ["place_chosen", "Chose a place"],
    ["itin_built", "Got an itinerary"],
    ["itin_failed", "Itinerary failed"],
    ["pair_answered", "Answered a this-or-that"],
    ["ask_sent", "Asked for a change"],
    ["trim_used", "Used Trim to fit"],
    ["book_click", "Clicked a booking or map link"],
    ["email_sent", "Emailed their trip"],
    ["pdf_saved", "Saved a PDF"],
    ["new_trip", "Started a new trip"],
]

const redis =
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
        ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
        : null

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

async function handler(req, res) {
    const want = process.env.STATS_KEY
    if (!want || String(req.query.key || "") !== want) return res.status(404).end()
    if (!redis) return res.status(503).send("Redis is not configured.")
    const n = Math.min(400, Math.max(1, parseInt(req.query.days, 10) || 30))
    const days = []
    for (let i = 0; i < n; i++) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10))
    const rows = await Promise.all(days.map((d) => redis.hgetall(`ae:stat:${d}`).then((h) => [d, h || {}])))
    const total = {}
    rows.forEach(([, h]) => Object.entries(h).forEach(([k, v]) => (total[k] = (total[k] || 0) + Number(v || 0))))
    if (req.query.format === "json") return res.status(200).json({ days: Object.fromEntries(rows), total })
    const head = `<tr><th>Last ${n} days</th><th>Total</th>${rows.map(([d]) => `<th>${esc(d.slice(5))}</th>`).join("")}</tr>`
    const body = ORDER.map(
        ([k, label]) =>
            `<tr><td>${esc(label)}</td><td><b>${total[k] || 0}</b></td>${rows.map(([, h]) => `<td>${Number(h[k] || 0) || ""}</td>`).join("")}</tr>`
    ).join("")
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader("Cache-Control", "no-store")
    return res.status(200).send(
        `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Away Edit stats</title>` +
            `<style>body{font:14px system-ui;background:#F9F7EF;color:#264E33;padding:24px}table{border-collapse:collapse}td,th{border-bottom:1px solid #dcd8c8;padding:6px 10px;text-align:right;white-space:nowrap}td:first-child,th:first-child{text-align:left}</style>` +
            `<h2>The Away Edit</h2><div style="overflow-x:auto"><table>${head}${body}</table></div>`
    )
}

export default withGuard(handler, {
    prefix: "stats",
    limit: 20,
    windowSec: 60,
    dailyCap: 500,
    requireOrigin: false,
    requireLimiter: false,
})
