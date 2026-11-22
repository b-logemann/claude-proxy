// api/stats.js - The Away Edit's private stats page (rebuilt Nov 2026).
//
// Open https://claude-proxy-brown.vercel.app/api/stats?key=<STATS_KEY>
// (STATS_KEY is any phrase you set in Vercel -> Settings -> Environment
// Variables). Add &days=30 for a longer table (default 14, max 400), or
// &format=json for the raw numbers.
//
// What it shows:
//   - Alerts: anything that needs a look (a cap being hit, failures, errors).
//   - At a glance: spend today and this month, cost per trip, build success,
//     how much of today's planning cap is used, SerpApi searches left.
//   - Spend by day: Claude, Google Places, SerpApi, emails.
//   - Trips: the funnel, how far people get through the questions, and why
//     builds failed.
//   - Health: calls per endpoint, requests turned away and why, errors.
//
// Where the numbers come from: the page's anonymous funnel counts
// (/api/track -> ae:stat:DAY) and the proxy's own meters (_meter.js ->
// ae:meter:DAY). Days are UTC, so a day starts at 6pm Chicago time.
//
// SPEND IS AN ESTIMATE from list prices. The bills are the truth:
// console.anthropic.com (Usage), Google Cloud (Billing), serpapi.com.
import { withGuard } from "./_guard.js"
import { redis, meterKey } from "./_meter.js"

// -- Prices (USD). Update these if a provider changes its prices. ----------
// Claude, per million tokens [input, output]. platform.claude.com pricing,
// Nov 2026. Haiku 5.5 is the price for prompts up to 100k tokens, which
// covers every call this site makes.
const CLAUDE = {
    "claude-sonnet-4-6": [3, 15],
    "claude-sonnet-4-5": [3, 15],
    "claude-sonnet-5-5": [2, 10],
    "claude-sonnet-5": [2, 10],
    "claude-haiku-5-5": [0.1, 0.5],
    "claude-haiku-4-5": [1, 5],
    "claude-opus-5-5": [4, 20],
}
const CLAUDE_FALLBACK = [3, 15] // an unlisted model is priced like Sonnet 4.6
// Google Places (New), per 1,000 calls, and the free calls each month.
// Google Maps Platform pricing, Nov 2026 (first price tier).
const GOOGLE = {
    places_text_ent: { label: "Place links and details (Text Search Enterprise)", per1000: 35, free: 1000 },
    places_text_pro: { label: "Photo search (Text Search Pro)", per1000: 32, free: 5000 },
    places_photo: { label: "Photos (Place Photo)", per1000: 7, free: 1000 },
}
// The guard's daily caps (keep in step with each file's withGuard options).
const CAPS = { "ask-claude": 500, "ask-change": 400, "place-link": 2000, pricing: 300, email: 100 }
// Resend's free plan: 100 emails a day, 3,000 a month. Change if you upgrade.
const RESEND_DAY = 100
const RESEND_MONTH = 3000
// Amber alert when estimated spend in one day passes this (Vercel env
// SPEND_ALERT_USD overrides it).
const SPEND_ALERT = Number(process.env.SPEND_ALERT_USD) || 10

// -- Rows ------------------------------------------------------------------
const FUNNEL = [
    ["intake_start", "Started the questions"],
    ["q_feel", "  reached “How should it feel?”"],
    ["q_who", "  reached “Who’s coming?”"],
    ["q_length", "  reached “How long?”"],
    ["q_budget", "  reached the budget"],
    ["q_summary", "  reached “Here’s your trip so far”"],
    ["intake_done", "Finished the questions"],
    ["options_shown", "Saw place options"],
    ["options_failed", "  place options failed"],
    ["place_chosen", "Chose a place"],
    ["out_of_trips", "Out of trips for today"],
    ["itin_built", "Got an itinerary"],
    ["itin_failed", "Itinerary failed"],
    ["fail_limit", "  hit a usage limit"],
    ["fail_slow", "  took too long"],
    ["fail_long", "  trip too long to write in one go"],
    ["fail_server", "  server or Claude error"],
    ["fail_network", "  couldn’t reach the server (their connection)"],
    ["fail_parse", "  answer came back unreadable"],
    ["fail_other", "  something else"],
]
const ENGAGE = [
    ["pair_answered", "Answered a this-or-that"],
    ["ask_sent", "Asked for a change"],
    ["trim_used", "Used Trim to fit"],
    ["book_click", "Clicked a booking or map link"],
    ["email_sent", "Emailed their trip"],
    ["pdf_saved", "Saved a PDF"],
    ["new_trip", "Started a new trip"],
]
const ERRORS = {
    "err:claude": "Claude errors (planning)",
    "err:claude_overloaded": "  of which Claude overloaded",
    "err:claude_truncated": "Planning answers cut off at the length limit",
    "err:ask_change": "Ask for a change errors",
    "err:ask_change_unclear": "Ask for a change: answer unreadable",
    "err:places_link": "Google Places errors (links)",
    "err:places_photo": "Google Places errors (photos)",
    "err:serpapi": "SerpApi errors",
    "err:limiter": "Rate limiter (Redis) errors",
}
const BLOCKS = {
    rate: "too many too fast",
    visitor_day: "one visitor’s daily limit",
    site_cap: "SITE DAILY CAP",
    origin: "not from your site",
}

// -- Helpers ---------------------------------------------------------------
const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const num = (v) => Number(v || 0) || 0
const usd = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`)
const int = (v) => Math.round(v).toLocaleString("en-US")
const sum = (rows, k) => rows.reduce((a, r) => a + num(r[k]), 0)

function claudeCost(h) {
    let c = 0
    for (const [k, v] of Object.entries(h)) {
        const m = k.match(/^claude_(in|out):(.+)$/)
        if (!m) continue
        const p = CLAUDE[m[2]] || CLAUDE_FALLBACK
        c += (num(v) / 1e6) * (m[1] === "in" ? p[0] : p[1])
    }
    return c
}
const claudeCostFor = (h, re) =>
    claudeCost(Object.fromEntries(Object.entries(h).filter(([k]) => re.test(k))))
const googleList = (h) => Object.entries(GOOGLE).reduce((a, [k, g]) => a + (num(h[k]) / 1000) * g.per1000, 0)
// Month to date with Google's free monthly calls taken off.
const googleBilled = (totals) =>
    Object.entries(GOOGLE).reduce(
        (a, [k, g]) => a + (Math.max(0, num(totals[k]) - g.free) / 1000) * g.per1000,
        0
    )

function addUp(hashes) {
    const t = {}
    hashes.forEach((h) => Object.entries(h).forEach(([k, v]) => (t[k] = (t[k] || 0) + num(v))))
    return t
}

async function serpAccount() {
    const key = process.env.SERPAPI_KEY
    if (!key) return null
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    try {
        // SerpApi's Account API does not use up a search.
        const r = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, {
            signal: ctrl.signal,
        })
        const j = await r.json()
        if (!r.ok || j.error) return { error: true }
        return {
            left: num(j.plan_searches_left ?? j.total_searches_left),
            perMonth: num(j.searches_per_month),
            plan: String(j.plan_name || ""),
        }
    } catch {
        return { error: true }
    } finally {
        clearTimeout(t)
    }
}

// -- Handler ---------------------------------------------------------------
async function handler(req, res) {
    const want = process.env.STATS_KEY
    if (!want || String(req.query.key || "") !== want) return res.status(404).end()
    if (!redis) return res.status(503).send("Redis is not configured.")

    const shown = Math.min(400, Math.max(1, parseInt(req.query.days, 10) || 14))
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    const monthStr = todayStr.slice(0, 7)
    const dayOfMonth = now.getUTCDate()
    // Always read the whole month (for month-to-date) and a week (for rates).
    const n = Math.max(shown, dayOfMonth, 7)
    const days = []
    for (let i = 0; i < n; i++) days.push(new Date(now.getTime() - i * 864e5).toISOString().slice(0, 10))

    const [statRows, meterRows, serp] = await Promise.all([
        Promise.all(days.map((d) => redis.hgetall(`ae:stat:${d}`).then((h) => h || {}))),
        Promise.all(days.map((d) => redis.hgetall(meterKey(d)).then((h) => h || {}))),
        serpAccount(),
    ])
    // One merged hash per day: funnel counts and meters never share a name.
    const merged = days.map((d, i) => ({ ...statRows[i], ...meterRows[i] }))
    const T = merged[0]
    const week = merged.slice(0, 7)
    const month = merged.filter((_, i) => days[i].startsWith(monthStr))
    const W = addUp(week)
    const M = addUp(month)

    // Spend
    const spendDay = (h) => claudeCost(h) + googleList(h)
    const spendToday = spendDay(T)
    const monthClaude = claudeCost(M)
    const monthGoogle = googleBilled(M)
    const monthSpend = monthClaude + monthGoogle
    const monthTrips = num(M.itin_built)
    const perTrip = monthTrips ? monthSpend / monthTrips : null
    const weekBuilt = num(W.itin_built)
    const weekFailed = num(W.itin_failed)
    const weekTries = weekBuilt + weekFailed
    const successPct = weekTries ? Math.round((weekBuilt / weekTries) * 100) : null
    const capUsed = num(T["call:ask-claude"])

    // Alerts: [level, text]. red = act now, amber = look today, blue = worth knowing.
    const alerts = []
    for (const [k, v] of Object.entries(T)) {
        const m = k.match(/^block_site_cap:(.+)$/)
        if (m && num(v))
            alerts.push(["red", `${m[1]} hit its daily cap today. ${int(num(v))} ${num(v) === 1 ? "request was" : "requests were"} turned away. Raise dailyCap in ${m[1]}.js if this was genuine traffic.`])
    }
    for (const [p, cap] of Object.entries(CAPS)) {
        const used = num(T[`call:${p}`])
        if (used >= cap * 0.8 && !num(T[`block_site_cap:${p}`]))
            alerts.push(["amber", `${p} has used ${int(used)} of its ${int(cap)} daily cap.`])
    }
    if (weekTries >= 5 && weekFailed / weekTries > 0.1) {
        const top = FUNNEL.filter(([k]) => k.startsWith("fail_"))
            .map(([k, l]) => [num(W[k]), l.trim()])
            .sort((a, b) => b[0] - a[0])[0]
        alerts.push(["amber", `${Math.round((weekFailed / weekTries) * 100)}% of itinerary builds failed this week (${weekFailed} of ${weekTries}).${top && top[0] ? ` Most common: ${top[1]}.` : ""}`])
    }
    if (num(T["err:claude"]) >= 3)
        alerts.push(["amber", `${num(T["err:claude"])} Claude errors today. If it keeps up, check credits and status at console.anthropic.com.`])
    if (num(T["err:places_link"]) + num(T["err:places_photo"]) >= 5)
        alerts.push(["amber", `Google Places is returning errors today (${num(T["err:places_link"]) + num(T["err:places_photo"])}). Check the API key and billing in Google Cloud.`])
    if (num(T["err:serpapi"]))
        alerts.push(["amber", `${num(T["err:serpapi"])} SerpApi errors today, so some hotel prices fell back to estimates.`])
    if (serp && !serp.error && serp.perMonth) {
        if (serp.left < 50) alerts.push(["red", `Only ${serp.left} SerpApi searches left this month. Real hotel prices stop when they run out.`])
        else if (serp.left < serp.perMonth * 0.15) alerts.push(["amber", `${int(serp.left)} SerpApi searches left this month (about ${int(serp.left / 4)} trips).`])
    }
    if (serp && serp.error) alerts.push(["amber", "Couldn’t reach SerpApi to check searches left."])
    if (num(T.email_failed)) alerts.push(["amber", `${num(T.email_failed)} trip emails failed to send today. Check resend.com → Logs.`])
    if (num(T.email_sent) >= RESEND_DAY * 0.8)
        alerts.push(["amber", `${num(T.email_sent)} of Resend’s ${RESEND_DAY} free emails a day used.`])
    if (num(M.email_sent) >= RESEND_MONTH * 0.8)
        alerts.push(["amber", `${int(num(M.email_sent))} of Resend’s ${int(RESEND_MONTH)} free emails this month used.`])
    if (spendToday > SPEND_ALERT)
        alerts.push(["amber", `Estimated spend today is ${usd(spendToday)}, above your ${usd(SPEND_ALERT)} alert.`])
    if (num(W["err:claude_truncated"]))
        alerts.push(["blue", `${num(W["err:claude_truncated"])} planning answers ran past the length limit this week (long trips).`])
    if (weekBuilt >= 10 && num(W.out_of_trips) / weekBuilt > 0.1)
        alerts.push(["blue", `${num(W.out_of_trips)} visitors ran out of their 3 trips this week. If that keeps up, 3 a day may be tight.`])
    const originBlocks = Object.entries(W).filter(([k]) => k.startsWith("block_origin:")).reduce((a, [, v]) => a + num(v), 0)
    if (originBlocks >= 50)
        alerts.push(["blue", `${int(originBlocks)} requests this week came from outside your site and were refused. The guard is doing its job.`])
    if (!Object.keys(addUp(meterRows)).length)
        alerts.push(["blue", "No spend recorded yet. Spend and health numbers start once the updated api files are deployed."])

    if (req.query.format === "json") {
        res.setHeader("Cache-Control", "no-store")
        return res.status(200).json({
            days: Object.fromEntries(days.map((d, i) => [d, merged[i]])),
            today: { spend: spendToday, itineraries: num(T.itin_built) },
            month: { spend: monthSpend, claude: monthClaude, google: monthGoogle, perTrip, totals: M },
            serpapi: serp,
            alerts,
        })
    }

    // -- Render --------------------------------------------------------------
    const view = merged.slice(0, shown)
    const vDays = days.slice(0, shown)
    const head = (first) =>
        `<tr><th>${esc(first)}</th><th>This month</th>${vDays.map((d) => `<th>${esc(d.slice(5))}</th>`).join("")}</tr>`
    const row = (label, monthVal, cells, cls = "") =>
        `<tr class="${cls}"><td>${esc(label)}</td>${monthVal === "0" ? `<td class="z">0</td>` : `<td><b>${monthVal}</b></td>`}${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`
    const countRow = (k, label) => {
        const ind = label.startsWith("  ")
        return row(label.trim(), num(M[k]) ? int(num(M[k])) : "0", view.map((h) => (num(h[k]) ? int(num(h[k])) : "")), ind ? "sub" : "")
    }
    const moneyRow = (label, f, monthVal, cls = "") =>
        row(label, monthVal, view.map((h) => {
            const v = f(h)
            return v >= 0.005 ? usd(v) : ""
        }), cls)

    const spendTable =
        head("Spend (estimate)") +
        moneyRow("Claude: planning", (h) => claudeCostFor(h, /sonnet|opus|fable/), usd(claudeCostFor(M, /sonnet|opus|fable/))) +
        moneyRow("Claude: Ask for a change", (h) => claudeCostFor(h, /haiku/), usd(claudeCostFor(M, /haiku/))) +
        Object.entries(GOOGLE)
            .map(([k, g]) => row(`Google: ${g.label}`, `${int(num(M[k]))} calls`, view.map((h) => (num(h[k]) ? int(num(h[k])) : ""))))
            .join("") +
        moneyRow("Google Places at list price", googleList, `${usd(monthGoogle)} after free calls`) +
        row("SerpApi hotel searches", int(num(M.serpapi)), view.map((h) => (num(h.serpapi) ? int(num(h.serpapi)) : ""))) +
        row("Emails sent (Resend)", int(num(M.email_sent)), view.map((h) => (num(h.email_sent) ? int(num(h.email_sent)) : ""))) +
        moneyRow("Total", spendDay, usd(monthSpend), "total")

    const tripsTable = head("Trips") + FUNNEL.map(([k, l]) => countRow(k, l)).join("") + ENGAGE.map(([k, l]) => countRow(k, l)).join("")

    const keysSeen = Object.keys(addUp(view.concat([M])))
    const callRows = keysSeen
        .filter((k) => k.startsWith("call:"))
        .sort()
        .map((k) => {
            const p = k.slice(5)
            return countRow(k, `Calls: ${p}${CAPS[p] ? ` (cap ${int(CAPS[p])}/day)` : ""}`)
        })
    const blockRows = keysSeen
        .filter((k) => k.startsWith("block_"))
        .sort()
        .map((k) => {
            const m = k.match(/^block_(.+?):(.+)$/)
            return countRow(k, `Turned away (${BLOCKS[m[1]] || m[1]}): ${m[2]}`)
        })
    const errRows = Object.entries(ERRORS).map(([k, l]) => countRow(k, l))
    const healthTable = head("Health") + callRows.join("") + blockRows.join("") + errRows.join("")

    const card = (label, value, note = "") =>
        `<div class="card"><div class="cl">${esc(label)}</div><div class="cv">${value}</div>${note ? `<div class="cn">${note}</div>` : ""}</div>`
    const cards = [
        card("Spend today", usd(spendToday), "estimate"),
        card("Spend this month", usd(monthSpend), `Claude ${usd(monthClaude)} · Google ${usd(monthGoogle)}`),
        card("Cost per trip", perTrip == null ? "–" : usd(perTrip), `${int(monthTrips)} itineraries this month`),
        card("Itineraries today", int(num(T.itin_built)), `${int(num(T.itin_failed))} failed`),
        card("Builds that worked", successPct == null ? "–" : `${successPct}%`, `last 7 days, ${int(weekTries)} tries`),
        card("Planning cap today", `${int(capUsed)} / ${int(CAPS["ask-claude"])}`, "Claude calls"),
        card(
            "SerpApi searches left",
            !serp ? "–" : serp.error ? "?" : int(serp.left),
            !serp ? "SERPAPI_KEY not set" : serp.error ? "couldn’t check" : `of ${int(serp.perMonth)} this month${serp.plan ? ` · ${esc(serp.plan)}` : ""}`
        ),
        card("Emails today", `${int(num(T.email_sent))} / ${RESEND_DAY}`, `${int(num(M.email_sent))} / ${int(RESEND_MONTH)} this month`),
    ].join("")

    const alertHtml = alerts.length
        ? alerts
              .sort((a, b) => ["red", "amber", "blue"].indexOf(a[0]) - ["red", "amber", "blue"].indexOf(b[0]))
              .map(([lvl, t]) => `<li class="${lvl}">${esc(t)}</li>`)
              .join("")
        : `<li class="ok">All clear. Nothing needs a look.</li>`

    const updated = now.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })

    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader("Cache-Control", "no-store")
    return res.status(200).send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
            `<title>Away Edit stats</title><style>
body{font:14px/1.45 system-ui,-apple-system,sans-serif;background:#F9F7EF;color:#264E33;margin:0;padding:24px 16px 48px}
main{max-width:1200px;margin:0 auto}
h1{font:400 28px Georgia,serif;margin:0}
.sub-h{color:rgba(38,78,51,.7);font-size:13px;margin:4px 0 20px}
h2{font:400 20px Georgia,serif;margin:32px 0 8px}
ul.alerts{list-style:none;padding:0;margin:0 0 20px}
ul.alerts li{padding:10px 14px;margin-bottom:6px;border-left:4px solid;background:#fff}
ul.alerts li.red{border-color:#B3261E;background:#FCEDEC}ul.alerts li.amber{border-color:#C98A1B;background:#FDF5E6}
ul.alerts li.blue{border-color:#3C6E8F;background:#EEF4F8}ul.alerts li.ok{border-color:#264E33;background:#EEF3EF}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
@media (min-width:900px){.cards{grid-template-columns:repeat(4,1fr)}}
.card{background:#fff;border:1px solid #dcd8c8;padding:12px 14px}
.cl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:rgba(38,78,51,.7)}
.cv{font:400 26px Georgia,serif;margin:2px 0}.cn{font-size:12px;color:rgba(38,78,51,.7)}
.wrap{overflow-x:auto;background:#fff;border:1px solid #dcd8c8}
table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ece9dc;padding:6px 10px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
th{font-weight:600;background:#F3F0E4;position:sticky;top:0}
td:first-child,th:first-child{text-align:left;position:sticky;left:0;background:inherit}
tr{background:#fff}tr.sub td:first-child{padding-left:26px;color:rgba(38,78,51,.75)}
tr.total td{font-weight:700;border-top:2px solid #264E33}
td.z{color:rgba(38,78,51,.35)}
@media (max-width:600px){td:first-child,th:first-child{white-space:normal;min-width:130px;max-width:150px}.cv{font-size:22px}}
.foot{margin-top:28px;font-size:12px;color:rgba(38,78,51,.7);max-width:760px}
</style><main>
<h1>The Away Edit</h1>
<div class="sub-h">Updated ${esc(updated)} (Chicago). Days below run on UTC, so each starts at 6pm Chicago time.</div>
<ul class="alerts">${alertHtml}</ul>
<div class="cards">${cards}</div>
<h2>Spend</h2><div class="wrap"><table>${spendTable}</table></div>
<h2>Trips</h2><div class="wrap"><table>${tripsTable}</table></div>
<h2>Health</h2><div class="wrap"><table>${healthTable}</table></div>
<p class="foot">Spend is an estimate from list prices. Your bills are the truth: console.anthropic.com (Usage), Google Cloud (Billing), serpapi.com and resend.com. Google gives some calls free each month; the monthly figure takes those off, the daily figures don’t. SerpApi and Resend are monthly plans, so they show as counts. Add &amp;days=30 to the address for a longer table.</p>
</main>`
    )
}

export default withGuard(handler, {
    prefix: "stats",
    limit: 20,
    windowSec: 60,
    dailyCap: 500,
    requireOrigin: false,
    requireLimiter: false,
    meterCalls: false,
})
