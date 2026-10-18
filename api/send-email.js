// api/send-email.js - structured input only. The client sends DATA; this file
// builds the HTML.
//
// Why this was rewritten rather than patched:
//
// The previous version interpolated chosenItineraryHTML, reservationsHTML and
// budgetHTML straight into the email body and into the .doc/.xls attachments.
// safe() was String(), which does not escape. AwayEdit.tsx calling esc() on
// its model fields before POSTing is no protection at all against someone
// POSTing directly. Combined with an unvalidated `to`, that made this endpoint
// able to send arbitrary HTML, from your verified domain, to any address - a
// phishing kit wearing your brand.
//
// Filtering HTML is a losing game. Not accepting it is not. Everything below
// is escaped on the way out, every URL is scheme-checked, and every array is
// length-capped, so a hostile payload can at worst produce an ugly email to
// its own sender.
//
// The CONTRACT below mirrors the shapes AwayEdit.tsx already builds - slots
// keep their title/detail/cost, booking rows keep their two links - so the
// email renders exactly as it does today, just from data instead of markup.
//
// BREAKING: AwayEdit.tsx must be updated in the same deploy.

import { withGuard } from "./_guard.js"

export const maxDuration = 60

/* ================================================================== *
 * BRAND - change colours and type here, nowhere else.
 *
 * Email clients do not load web fonts reliably (Gmail strips them), so
 * Bonny and Switzer cannot be used. These are the closest standard
 * pairing. The email will never look identical to the site; it should
 * read as unmistakably yours.
 * ================================================================== */

const GREEN = "rgb(38, 78, 51)"
const BEIGE = "rgb(249, 247, 239)"

const G80 = "rgba(38,78,51,.8)"
const G75 = "rgba(38,78,51,.75)"
const G60 = "rgba(38,78,51,.6)"
const G55 = "rgba(38,78,51,.55)"
const G50 = "rgba(38,78,51,.5)"
const G40 = "rgba(38,78,51,.4)"
const RULE = "rgba(38,78,51,.3)"
const RULE_SOFT = "rgba(38,78,51,.1)"
const WASH = "rgba(38,78,51,.07)"

// Multi-word family names MUST be quoted. The previous version wrote
// `font-family:Helvetica Neue,sans-serif`, which is invalid CSS - several
// clients dropped the declaration and fell back to Times.
const SERIF = "Georgia,'Times New Roman',serif"
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif"

/* ================================================================== *
 * COMPLIANCE
 * CAN-SPAM wants a real physical postal address on commercial mail and a
 * working unsubscribe path. Set these in the Vercel env before launch;
 * the footer omits any line whose variable is unset rather than printing
 * a placeholder. Punch list #6 is the plumbing being present, not the
 * compliance sign-off - and I am not a lawyer.
 * ================================================================== */

const SITE_URL = process.env.SITE_URL || "https://theawayedit.com"
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || ""
const MAILING_ADDRESS = process.env.MAILING_ADDRESS || ""
const PRIVACY_URL = process.env.PRIVACY_URL || ""
const UNSUBSCRIBE_URL = process.env.UNSUBSCRIBE_URL || ""

/* ================================================================== *
 * AFFILIATE MARKERS
 * Belt and braces. AwayEdit.tsx sets TP_MARKER = "" for launch, so links
 * should arrive clean already - but stripping here too means a stale
 * client build, or anything else calling this endpoint, cannot put a
 * marker into an email. Server-side, so it cannot be bypassed.
 *
 * EMAIL_STRIP_AFFILIATE=false disables it, only after confirming the
 * programme permits email distribution. Travelpayouts' terms are not
 * Amazon's.
 * ================================================================== */

const STRIP_AFFILIATE = process.env.EMAIL_STRIP_AFFILIATE !== "false"

const AFFILIATE_PARAMS = new Set([
    "marker", "shmarker", "trs",                    // Travelpayouts
    "aid", "label",                                 // Booking
    "partner", "partner_id", "partnerid", "pid",
    "mcid", "medium", "campaign",                   // GYG / Viator / generic
    "tag", "ascsubtag",                             // Amazon
    "affiliate", "aff", "aff_id", "refid", "ref_id",
    "irclickid", "clickid", "click_id", "subid", "sub_id", "trk", "trkid",
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "fbclid",
])

/* ------------------------------------------------------------------ *
 * CONTRACT - what AwayEdit.tsx must now POST
 *
 * {
 *   email: "one@address.com",          // single string, never an array
 *   turnstileToken?: "...",
 *   trip: { destination, tripType, tripTiming, tripLength,
 *           numberOfPeople, budgetPerPerson },
 *   itinerary: {
 *     title, subtitle, summary,
 *     days: [{
 *       title: "Day 1 - Arrival",
 *       slots: [{ time, title, detail, cost }]
 *     }]
 *   },
 *   bookings: [{ group: "(1) Flights", items: [
 *     { label, detail, links: [{ text, url }] }
 *   ]}],
 *   budget: {
 *     rows:  [{ label, amount, note }],   // note e.g. "from your plan"
 *     total: { label, amount },
 *     footnote: "..."
 *   },
 *   checklist?: [{ category, items: ["..."] }],
 *   packing?:   [{ category, items: ["..."] }]
 * }
 *
 * Everything except `email` is optional. Unknown fields are ignored.
 * ------------------------------------------------------------------ */

// ---- coercion + escaping -------------------------------------------------

const MAX_SHORT = 300
const MAX_LONG = 3000
const MAX_DAYS = 31
const MAX_SLOTS = 20
const MAX_GROUPS = 15
const MAX_ITEMS = 60
const MAX_LINKS = 4
const MAX_ROWS = 40

function esc(v) {
    return String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

// Bounded plain string. Objects and arrays become "" rather than
// "[object Object]", so a nested payload cannot smuggle anything through.
function str(v, max = MAX_SHORT) {
    if (v == null) return ""
    if (typeof v === "object") return ""
    return String(v).slice(0, max)
}

function arr(v, max) {
    return Array.isArray(v) ? v.slice(0, max) : []
}

// Only http(s). Blocks javascript:, data:, vbscript: and friends.
function safeUrl(v) {
    const s = str(v, 2000)
    if (!s) return null
    try {
        const u = new URL(s)
        if (u.protocol !== "http:" && u.protocol !== "https:") return null
        return u
    } catch {
        return null
    }
}

// Scheme-check, then remove attribution and tracking parameters.
function linkUrl(v) {
    const u = safeUrl(v)
    if (!u) return null
    if (STRIP_AFFILIATE) {
        for (const key of [...u.searchParams.keys()]) {
            if (AFFILIATE_PARAMS.has(key.toLowerCase()))
                u.searchParams.delete(key)
        }
    }
    return u.toString()
}

// Deliberately strict: one address, no commas, no angle brackets, no display
// name. Resend accepts an array for `to`, so an unvalidated value here is a
// bulk-send primitive.
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/

function validEmail(v) {
    if (typeof v !== "string") return null
    const s = v.trim()
    if (s.length < 5 || s.length > 254) return null
    if (!EMAIL_RE.test(s)) return null
    return s
}

// ---- renderers -----------------------------------------------------------

const cell = `padding:9px 0;border-bottom:1px solid ${RULE_SOFT};`

function renderItinerary(itin) {
    const days = arr(itin.days, MAX_DAYS)

    const dayHtml = days
        .map((d) => {
            const slots = arr(d.slots, MAX_SLOTS)
                .map((s) => {
                    const title = esc(str(s.title, MAX_SHORT))
                    if (!title) return ""
                    const time = esc(str(s.time, 60))
                    const detail = esc(str(s.detail, MAX_LONG))
                    const cost = esc(str(s.cost, 80))
                    return `<tr><td style="${cell}">
                        ${time ? `<div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${G55};margin-bottom:3px;">${time}</div>` : ""}
                        <div style="font-size:15px;font-weight:600;color:${GREEN};">${title}</div>
                        ${detail ? `<div style="font-size:13px;line-height:1.55;color:${G75};margin-top:2px;">${detail}</div>` : ""}
                        ${cost ? `<div style="font-size:12px;color:${G55};margin-top:3px;">${cost}</div>` : ""}
                    </td></tr>`
                })
                .filter(Boolean)
                .join("")

            if (!slots) return ""

            return `<div style="margin-bottom:26px;">
                <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${GREEN};border-bottom:1px solid ${RULE};padding-bottom:7px;margin-bottom:6px;">${esc(str(d.title, 120))}</div>
                <table role="presentation" width="100%" style="border-collapse:collapse;">${slots}</table>
            </div>`
        })
        .filter(Boolean)
        .join("")

    const title = esc(str(itin.title, 200))
    const subtitle = esc(str(itin.subtitle, 200))
    const summary = esc(str(itin.summary, MAX_LONG))

    if (!dayHtml && !summary) return ""

    return `<div style="font-family:${SERIF};color:${GREEN};">
        ${title ? `<div style="font-size:22px;margin-bottom:6px;">${title}</div>` : ""}
        ${subtitle ? `<div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${G55};margin-bottom:14px;">${subtitle}</div>` : ""}
        ${summary ? `<div style="font-family:${SANS};font-size:14px;line-height:1.7;color:${G80};margin-bottom:26px;">${summary}</div>` : ""}
        <div style="font-family:${SANS};">${dayHtml}</div>
    </div>`
}

// withLinks:false renders labels as plain text - used for the guest copy,
// which is meant to be forwarded and carries no booking links at all.
function renderBookings(groups, { withLinks = true } = {}) {
    const gs = arr(groups, MAX_GROUPS)
    if (!gs.length) return ""

    const linkStyle = `font-family:${SANS};font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;color:${GREEN};text-decoration:none;border-bottom:1px solid ${G40};white-space:nowrap;margin-right:14px;`

    return gs
        .map((g) => {
            const rows = arr(g.items, MAX_ITEMS)
                .map((it) => {
                    const label = esc(str(it.label, MAX_SHORT))
                    if (!label) return ""
                    const detail = esc(str(it.detail, MAX_SHORT))

                    const links = withLinks
                        ? arr(it.links, MAX_LINKS)
                              .map((l) => {
                                  const url = linkUrl(l.url)
                                  const text = esc(str(l.text, 60))
                                  if (!url || !text) return ""
                                  return `<a href="${esc(url)}" style="${linkStyle}">${text} &rarr;</a>`
                              })
                              .filter(Boolean)
                              .join("")
                        : ""

                    return `<div style="padding:9px 0;border-bottom:1px solid ${RULE_SOFT};font-family:${SANS};font-size:14px;color:${GREEN};">
                        <div style="font-weight:500;margin-bottom:${links || detail ? "5px" : "0"};">${label}</div>
                        ${detail ? `<div style="font-size:12px;font-weight:300;color:${G60};margin-bottom:${links ? "6px" : "0"};">${detail}</div>` : ""}
                        ${links ? `<div>${links}</div>` : ""}
                    </div>`
                })
                .filter(Boolean)
                .join("")

            if (!rows) return ""

            return `<div style="margin-bottom:22px;">
                <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${GREEN};border-bottom:1px solid ${RULE};padding-bottom:6px;margin-bottom:6px;">${esc(str(g.group, 120))}</div>
                ${rows}
            </div>`
        })
        .filter(Boolean)
        .join("")
}

function renderBudget(budget) {
    const rows = arr(budget?.rows, MAX_ROWS)
    if (!rows.length) return ""

    const noteStyle = `font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:${G50};`

    const body = rows
        .map((r) => {
            const label = esc(str(r.label, MAX_SHORT))
            if (!label) return ""
            const note = esc(str(r.note, 60))
            return `<tr>
                <td style="${cell}">${label}${note ? ` <span style="${noteStyle}">${note}</span>` : ""}</td>
                <td style="${cell}text-align:right;">${esc(str(r.amount, 40))}</td>
            </tr>`
        })
        .filter(Boolean)
        .join("")

    if (!body) return ""

    const t = budget?.total
    const foot = t
        ? `<tfoot><tr>
               <td style="padding:11px 0;font-weight:700;border-top:2px solid ${GREEN};">${esc(str(t.label, MAX_SHORT)) || "Total"}</td>
               <td style="padding:11px 0;font-weight:700;text-align:right;border-top:2px solid ${GREEN};">${esc(str(t.amount, 40))}</td>
           </tr></tfoot>`
        : ""

    const footnote = esc(str(budget?.footnote, MAX_LONG))

    return `<table role="presentation" width="100%" style="border-collapse:collapse;font-family:${SANS};font-size:14px;color:${GREEN};">
        <thead><tr>
            <th style="text-align:left;padding:7px 0;font-size:10px;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid ${RULE};">Category</th>
            <th style="text-align:right;padding:7px 0;font-size:10px;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid ${RULE};">Estimated</th>
        </tr></thead>
        <tbody>${body}</tbody>
        ${foot}
    </table>
    ${footnote ? `<div style="font-family:${SANS};font-size:12px;color:${G60};line-height:1.6;margin-top:10px;">${footnote}</div>` : ""}`
}

function renderCategoryList(sections) {
    const ss = arr(sections, MAX_GROUPS)
    if (!ss.length) return ""

    return ss
        .map((s) => {
            const items = arr(s.items, MAX_ITEMS)
                .map((i) => esc(str(i, MAX_SHORT)))
                .filter(Boolean)
                .map((i) => `<li style="margin-bottom:6px;">${i}</li>`)
                .join("")
            if (!items) return ""
            return `<div style="margin-bottom:20px;">
                <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${GREEN};margin-bottom:8px;">${esc(str(s.category, 120))}</div>
                <ul style="font-family:${SANS};font-size:14px;font-weight:300;color:${GREEN};line-height:1.7;margin:0;padding-left:20px;">${items}</ul>
            </div>`
        })
        .filter(Boolean)
        .join("")
}

function renderFooter() {
    const small = `font-family:${SANS};font-size:11px;color:${G50};line-height:1.6;`
    const bits = [
        `<p style="font-family:${SERIF};font-size:22px;font-weight:300;color:${GREEN};margin:0 0 8px;">The Away Edit</p>`,
    ]

    const contact = [SITE_URL.replace(/^https?:\/\//, ""), CONTACT_EMAIL]
        .filter(Boolean)
        .map(esc)
        .join(" &nbsp;&middot;&nbsp; ")
    if (contact) bits.push(`<p style="${small}margin:0 0 10px;">${contact}</p>`)

    // CAN-SPAM: physical postal address.
    if (MAILING_ADDRESS)
        bits.push(`<p style="${small}margin:0 0 10px;">${esc(MAILING_ADDRESS)}</p>`)

    const links = []
    if (PRIVACY_URL)
        links.push(`<a href="${esc(PRIVACY_URL)}" style="color:${G60};">Privacy policy</a>`)
    if (UNSUBSCRIBE_URL)
        links.push(`<a href="${esc(UNSUBSCRIBE_URL)}" style="color:${G60};">Unsubscribe</a>`)
    if (links.length)
        bits.push(`<p style="${small}margin:0 0 10px;">${links.join(" &nbsp;&middot;&nbsp; ")}</p>`)

    bits.push(
        `<p style="font-family:${SANS};font-size:10px;color:${G40};margin:0;">You own every booking in this plan - The Away Edit books nothing on your behalf. Please verify all venues, prices and availability independently before confirming.</p>`
    )

    return `<div style="border-top:1px solid ${RULE};padding-top:32px;text-align:center;">${bits.join("")}</div>`
}

// ---- attachments ---------------------------------------------------------

const toB64 = (s) => Buffer.from(s, "utf-8").toString("base64")

function docWrap(inner) {
    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8" /><title>The Away Edit</title>
<style>
  body { font-family: ${SERIF}; color: ${GREEN}; padding: 32px; line-height: 1.6; }
  h1 { font-weight: 300; font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; border-bottom: 1px solid ${RULE}; padding-bottom: 6px; margin: 28px 0 14px; font-family: ${SANS}; }
  .brand { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: ${G60}; font-family: ${SANS}; }
  .meta { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: ${G60}; font-family: ${SANS}; margin: 0 0 20px; }
  table { width: 100%; border-collapse: collapse; }
  .disclaimer { font-size: 10px; color: ${G50}; border-top: 1px solid ${RULE_SOFT}; padding-top: 10px; margin-top: 28px; font-family: ${SANS}; }
</style></head>
<body>
  <p class="brand">The Away Edit</p>
  ${inner}
  <p class="disclaimer">You own every booking in this plan. Recommendations are curated suggestions and may have changed - always verify venues, prices and availability before booking.</p>
</body></html>`
}

// ---- handler -------------------------------------------------------------

async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).end()

    const body = req.body || {}

    const email = validEmail(body.email)
    if (!email) {
        // Same message whether missing or malformed - no probing feedback.
        return res.status(400).json({ error: "A valid email address is required" })
    }

    if (process.env.TURNSTILE_SECRET_KEY) {
        const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        try {
            const verify = await fetch(
                "https://challenges.cloudflare.com/turnstile/v0/siteverify",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        secret: process.env.TURNSTILE_SECRET_KEY,
                        response: str(body.turnstileToken, 4000),
                        ...(ip ? { remoteip: ip } : {}),
                    }),
                }
            )
            const outcome = await verify.json()
            if (!outcome.success)
                return res
                    .status(403)
                    .json({ error: "Verification failed. Please try again." })
        } catch (err) {
            console.error("[send-email] turnstile check failed", err)
            return res
                .status(503)
                .json({ error: "Verification unavailable. Please try again." })
        }
    }

    const trip = body.trip || {}
    const itin = body.itinerary || {}
    const title = str(itin.title, 200) || "Your Away Edit"

    const metaLine = [
        str(trip.destination),
        str(trip.tripType),
        trip.tripLength ? `${str(trip.tripLength, 20)} days` : "",
        str(trip.tripTiming),
        trip.numberOfPeople ? `${str(trip.numberOfPeople, 20)} people` : "",
        trip.budgetPerPerson ? `${str(trip.budgetPerPerson, 30)}/person` : "",
    ]
        .filter(Boolean)
        .map(esc)
        .join(" &nbsp;&middot;&nbsp; ")

    const itinHtml = renderItinerary(itin)
    const bookingsHtml = renderBookings(body.bookings)
    const budgetHtml = renderBudget(body.budget)
    const checklistHtml = renderCategoryList(body.checklist)
    const packingHtml = renderCategoryList(body.packing)

    const eyebrow = `font-family:${SANS};font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${GREEN};margin:0 0 20px;border-bottom:1px solid ${RULE};padding-bottom:10px;`
    const section = (heading, html) =>
        html
            ? `<div style="margin-bottom:44px;"><p style="${eyebrow}">${heading}</p>${html}</div>`
            : ""

    const emailHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BEIGE};font-family:${SERIF};">
  <div style="max-width:640px;margin:0 auto;padding:0;">

    <div style="background:${GREEN};padding:48px 40px 40px;text-align:center;">
      <p style="font-family:${SANS};font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(249,247,239,0.6);margin:0 0 12px;">Your Curated Itinerary</p>
      <h1 style="font-family:${SERIF};font-weight:300;font-size:42px;color:${BEIGE};margin:0;letter-spacing:0.04em;">The Away Edit</h1>
    </div>

    ${
        metaLine
            ? `<div style="background:rgba(38,78,51,0.08);padding:20px 40px;border-bottom:1px solid rgba(38,78,51,0.15);">
                   <p style="font-family:${SANS};font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${GREEN};margin:0;">${metaLine}</p>
               </div>`
            : ""
    }

    <div style="padding:40px;">
      ${section("Your Itinerary", itinHtml)}
      ${section("Reservations &amp; Bookings", bookingsHtml)}
      ${section("Planning Checklist", checklistHtml)}
      ${section("Packing List", packingHtml)}
      ${section("What It Costs", budgetHtml)}

      <p style="font-family:${SANS};font-size:11px;color:${G50};line-height:1.6;margin:0 0 32px;">AI-generated itinerary. All venues, prices and availability should be verified independently before booking.</p>

      ${renderFooter()}
    </div>
  </div>
</body>
</html>`

    // ---- attachments, built from the same escaped data ----

    const fileBase = `The Away Edit - ${str(trip.destination) || title}`
        .replace(/[^\w\s.-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)

    const metaPlain = metaLine ? `<p class="meta">${metaLine}</p>` : ""

    // 1) Guest copy - itinerary and packing only, no booking links at all.
    //    The one meant to be forwarded to the group.
    const guestDoc = docWrap(
        `<h1>${esc(title)}</h1>${metaPlain}` +
            itinHtml +
            (packingHtml ? `<h2>Packing List</h2>${packingHtml}` : "")
    )

    // 2) Planning copy - booking links (markers stripped) plus the checklist.
    const adminDoc = docWrap(
        `<h1>${esc(title)} - Planning Copy</h1>${metaPlain}` +
            (bookingsHtml ? `<h2>Reservations &amp; Bookings</h2>${bookingsHtml}` : "") +
            (checklistHtml ? `<h2>Planning Checklist</h2>${checklistHtml}` : "") +
            `<h2>Itinerary</h2>${itinHtml}`
    )

    const attachments = [
        { filename: `${fileBase} - Itinerary.doc`, content: toB64(guestDoc) },
        {
            filename: `${fileBase} - Planning and Booking Links.doc`,
            content: toB64(adminDoc),
        },
    ]

    // 3) Budget - Excel-openable .xls.
    if (budgetHtml) {
        const budgetXls = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Budget</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head><body><h3>The Away Edit - ${esc(str(trip.destination) || title)} Budget</h3>${budgetHtml}</body></html>`
        attachments.push({
            filename: `${fileBase} - Budget.xls`,
            content: toB64(budgetXls),
        })
    }

    try {
        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                from: process.env.FROM_EMAIL,
                to: email, // validated single address
                subject: `Your Away Edit - ${title}`,
                html: emailHTML,
                attachments,
                ...(UNSUBSCRIBE_URL
                    ? {
                          headers: {
                              "List-Unsubscribe": `<${UNSUBSCRIBE_URL}>`,
                              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                          },
                      }
                    : {}),
            }),
        })

        const data = await response.json()

        if (!response.ok) {
            console.error("[send-email] resend error", data)
            return res.status(502).json({ error: "Failed to send email" })
        }

        return res.status(200).json({ success: true })
    } catch (err) {
        console.error("[send-email] unexpected", err)
        return res.status(500).json({ error: "Unexpected error" })
    }
}

export default withGuard(handler, {
    prefix: "email",
    limit: 3,
    windowSec: 3600,
    dailyCap: 100,
})
