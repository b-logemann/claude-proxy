// api/ask-change.js - "Ask for a change" on the trip page (Nov 2026).
//
// NOT a general chat endpoint. The client sends the traveller's request, the
// plan as it stands (slots) and the spare options; this asks the model for a
// few OPERATIONS on that plan and returns only operations that are valid:
//
//   { op: "put",      slot: "<slot key>", id: "<spare id>" }   swap a spare in
//   { op: "remove",   slot: "<slot key>" }                      take it out
//   { op: "move",     slot: "<slot key>", day: <n> }            move it to another day
//   { op: "add",      day: <n>, id: "<spare id>" }              add a spare without replacing anything
//   { op: "dayPace",  day: <n>, pace: 0|1|2 }                   one day busier/easier
//   { op: "dial",     dial: "pace"|"food"|"spend", value: 0|1|2 }
//
// The fixed instructions live here, so the endpoint cannot be used to ask the
// model anything else, and its own rate limit keeps it from eating into trip
// generation's (ask-claude). Everything in the response is re-checked against
// the request before it is returned; the client checks again before applying.

import { withGuard } from "./_guard.js"

export const maxDuration = 30

// Same key as ask-claude.js. If ask-claude reads a different variable name,
// use that one here.
const API_KEY = process.env.ANTHROPIC_API_KEY
// A small, fast model is plenty for picking from a list. Override in Vercel.
const MODEL = process.env.ASK_CHANGE_MODEL || "claude-haiku-5-5"

const MAX_REQUEST = 300
const MAX_SLOTS = 80
const MAX_SPARES = 40
const MAX_DAYS = 62
const MAX_OPS = 8

const str = (v, max) => (v == null || typeof v === "object" ? "" : String(v).slice(0, max))
const num = (v, lo, hi) => {
    const n = Number(v)
    return isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : lo
}
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : [])

const SYSTEM = `You edit a travel plan for The Away Edit. You do not chat, and you cannot book, buy, search the web, or plan a different place.

You receive JSON: "request" (what the traveller typed), "trip" (city, days with weekday/date/theme, the current dials), "slots" (the plan: each slot has a key, day, band "day" or "eve", and what is in it), and "spares" (unused options, each with an id, type, area, its natural day and band, and price per person "pp").

Reply with ONLY a JSON object, no prose around it:
{"reply": "<one short sentence, warm and plain, saying what you did or why you could not>",
 "ops": [ ...at most 6 operations... ]}

Operations:
- {"op":"put","slot":"<slot key>","id":"<spare id>"}  put a spare into an existing slot (replacing what is there)
- {"op":"remove","slot":"<slot key>"}  take a slot's item out
- {"op":"add","day":<day number>,"id":"<spare id>"}  ADD a spare to that day, keeping everything already planned (the plan opens a second daytime slot itself)
- {"op":"move","slot":"<slot key>","day":<day number>}  move what is in that slot to another day (the plan makes room there itself, even on a day with no slot)
- {"op":"dayPace","day":<day number>,"pace":0|1|2}  make ONE day easier (0) or busier (2); the plan refills that day itself
- {"op":"dial","dial":"pace"|"food"|"spend","value":0|1|2}  change a whole-trip setting (pace: easy/balanced/packed; food: casual/mix/special; spend: save/balanced/splurge)

Rules:
- Only use slot keys and spare ids that appear in the input. Never invent places.
- Keep evening spares in "eve" slots and daytime spares in "day" slots.
- A spare should go on its own day or one day either side; never move something tied to particular days (markets, shows, "only on").
- "Add", "also", "something more", "fit in" = use "add", never "put": "put" REPLACES what is in a slot. Only use "put" when they ask to swap or replace.
- "Use more of the budget" = turn spend up one step, or add or put pricier spares; say so.
- When the traveller asks to move something to another day, use "move". Their request is enough reason, even for something tied to particular days, unless it is closed or not running that day.
- "Busier"/"more packed" for a day = dayPace 2. "Easier"/"lighter"/"free afternoon" = dayPace 0 (or remove).
- "Cheaper" = put cheaper spares in place of pricier items, or turn spend down; say roughly what it saves if you can.
- Change as little as possible. Do not touch days the traveller did not mention unless the request is about the whole trip.
- The reply talks about their trip, never about slots, keys, ids or how the plan works inside.
- If nothing fits, or the request is outside what you can do (booking, flights, hotels, another city, anything not about this plan), return "ops": [] and say so in the reply, pointing them to the booking links on the page where relevant.`

function clean(body) {
    const trip = body.trip || {}
    return {
        request: str(body.request, MAX_REQUEST),
        trip: {
            city: str(trip.city, 80),
            people: num(trip.people, 1, 30),
            stay: str(trip.stay, 120),
            pace: num(trip.pace, 0, 2),
            food: num(trip.food, 0, 2),
            spend: num(trip.spend, 0, 2),
            days: arr(trip.days, MAX_DAYS).map((d) => ({
                day: num(d && d.day, 1, MAX_DAYS),
                weekday: str(d && d.weekday, 12),
                date: str(d && d.date, 12),
                theme: str(d && d.theme, 80),
                first: !!(d && d.first),
                last: !!(d && d.last),
            })),
        },
        slots: arr(body.slots, MAX_SLOTS).map((x) => ({
            slot: str(x && x.slot, 20),
            day: num(x && x.day, 1, MAX_DAYS),
            band: x && x.band === "eve" ? "eve" : "day",
            title: str(x && x.title, 120),
            type: str(x && x.type, 20),
            area: str(x && x.area, 60),
            pp: num(x && x.pp, 0, 100000),
            removed: !!(x && x.removed),
        })),
        spares: arr(body.spares, MAX_SPARES).map((x) => ({
            id: str(x && x.id, 40),
            title: str(x && x.title, 120),
            type: str(x && x.type, 20),
            area: str(x && x.area, 60),
            day: num(x && x.day, 1, MAX_DAYS),
            band: x && x.band === "eve" ? "eve" : "day",
            pp: num(x && x.pp, 0, 100000),
            splurge: !!(x && x.splurge),
            note: str(x && x.note, 120),
        })),
    }
}

function parseJSON(text) {
    const t = String(text || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "")
    const a = t.indexOf("{")
    const b = t.lastIndexOf("}")
    if (a < 0 || b <= a) return null
    try {
        return JSON.parse(t.slice(a, b + 1))
    } catch {
        return null
    }
}

// Keep only operations that point at things the request actually contained.
function validOps(ops, input) {
    const slotKeys = new Set(input.slots.map((s) => s.slot))
    const spareIds = new Set(input.spares.map((s) => s.id))
    const nDays = input.trip.days.length || MAX_DAYS
    const out = []
    for (const o of arr(ops, MAX_OPS)) {
        if (!o || typeof o !== "object") continue
        if (o.op === "put" && slotKeys.has(o.slot) && spareIds.has(o.id))
            out.push({ op: "put", slot: o.slot, id: o.id })
        else if (o.op === "remove" && slotKeys.has(o.slot)) out.push({ op: "remove", slot: o.slot })
        else if (o.op === "add" && spareIds.has(o.id) && Number(o.day) >= 1 && Number(o.day) <= nDays)
            out.push({ op: "add", day: num(o.day, 1, nDays), id: o.id })
        else if (o.op === "move" && slotKeys.has(o.slot) && Number(o.day) >= 1 && Number(o.day) <= nDays)
            out.push({ op: "move", slot: o.slot, day: num(o.day, 1, nDays) })
        else if (o.op === "dayPace" && Number(o.day) >= 1 && Number(o.day) <= nDays)
            out.push({ op: "dayPace", day: num(o.day, 1, nDays), pace: num(o.pace, 0, 2) })
        else if (o.op === "dial" && ["pace", "food", "spend"].includes(o.dial))
            out.push({ op: "dial", dial: o.dial, value: num(o.value, 0, 2) })
    }
    return out
}

async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).end()
    const input = clean(req.body || {})
    if (!input.request.trim()) return res.status(400).json({ error: "Nothing asked" })
    if (!input.slots.length) return res.status(400).json({ error: "No plan" })
    if (!API_KEY) {
        console.error("[ask-change] ANTHROPIC_API_KEY is not set")
        return res.status(500).json({ error: "Not configured" })
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 25000)
    try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1200,
                system: SYSTEM,
                messages: [{ role: "user", content: JSON.stringify(input) }],
            }),
            signal: ctrl.signal,
        })
        const data = await r.json().catch(() => null)
        if (!r.ok || !data) {
            console.error("[ask-change] upstream", r.status, data && data.error)
            return res.status(502).json({ error: "Planner unavailable" })
        }
        const text = (data.content || []).map((c) => (c && c.type === "text" ? c.text : "")).join("")
        let parsed = parseJSON(text)
        // Persona test, Nov 2026: a long, natural request came back as
        // something that was not JSON, and the traveller got "I didn't quite
        // catch that". One retry, asking for the JSON only.
        if (!parsed) {
            const r2 = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: MODEL,
                    max_tokens: 1200,
                    system: SYSTEM,
                    messages: [
                        { role: "user", content: JSON.stringify(input) },
                        { role: "assistant", content: String(text || "").slice(0, 2000) || "(no answer)" },
                        { role: "user", content: "Reply again with ONLY the JSON object described in your instructions: {\"reply\": ..., \"ops\": [...]}. No other text." },
                    ],
                }),
                signal: ctrl.signal,
            })
            const d2 = await r2.json().catch(() => null)
            if (r2.ok && d2)
                parsed = parseJSON((d2.content || []).map((c) => (c && c.type === "text" ? c.text : "")).join(""))
        }
        if (!parsed) return res.status(200).json({ reply: "I didn't quite catch that. Could you say it another way?", ops: [] })
        return res.status(200).json({
            reply: str(parsed.reply, 300),
            ops: validOps(parsed.ops, input),
        })
    } catch (err) {
        console.error("[ask-change] unexpected", err && err.name)
        return res.status(504).json({ error: "Took too long" })
    } finally {
        clearTimeout(timer)
    }
}

// Its own bucket: 20 requests an hour per visitor, 400 a day across the site.
// (The client also stops at 15 per trip; see LIMITS in AwayEdit.tsx.)
export default withGuard(handler, {
    prefix: "ask-change",
    limit: 20,
    windowSec: 3600,
    dailyCap: 400,
})
