// api/send-email.js - structured input only. The client sends DATA; this file
// builds the HTML.
//
// Why this was rewritten rather than patched (first rewrite):
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
// ------------------------------------------------------------------
// SECOND REVISION - a short covering note plus three attachments.
//
// (An intermediate version put everything inline with no attachments; that
// was reverted because a 21-day itinerary rendered inline exceeded Gmail's
// 102KB clip threshold and was silently truncated mid-plan. The body is now
// ~6KB regardless of trip length.)
//
// It used to send three: an itinerary .doc, a planning .doc, and a budget
// .xls. Every one of them duplicated a section that was already in the email
// body, so a recipient received the same trip four times in four formats. They
// were also HTML wearing Office extensions, which phones open badly or not at
// all.
//
// They are gone. What is left is a single well-ordered document that reads on
// a phone, forwards cleanly, and prints to a decent PDF from any mail client -
// which is the only "attachment" anyone actually wanted.
//
// Section order now matches how the thing is used, not how it was built:
//   the number -> what to book -> the plan -> the full cost table
// Money first because it is the question anyone forwarded this asks first, and
// it used to be buried at the bottom under a table they had to read to answer
// it. Bookings above the itinerary because they are the only time-sensitive
// part. The day-by-day below both, because they already read it on the site.
//
// Itinerary slots and booking rows now accept an optional `address`, rendered
// as a maps link. That is what keeps this useful AFTER everything is booked -
// the point at which every booking link above it has been spent. Omitted
// silently when the Places lookup had none; a wrong address is worse than no
// address.
// ------------------------------------------------------------------

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

/* ---- Dark mode ----------------------------------------------------------
 * iOS Mail and Apple Mail force-invert any email that does not declare it
 * handles dark mode. Inverting a dark desaturated green lands it in mint/teal,
 * which is what the brand was turning into on a phone.
 *
 * Two parts, both needed:
 *   1. the color-scheme meta tags below, which STOP the forced inversion
 *   2. these colours, applied by media query, so dark mode is a design
 *      decision rather than an algorithm's guess
 *
 * The overrides need !important because inline styles otherwise win, and
 * inline is the only thing every client respects in the first place.
 *
 * Coverage is honest, not total: Apple Mail, iOS Mail and Outlook.com follow
 * this. The Gmail app applies its own transformation and largely ignores
 * prefers-color-scheme, so it stays approximate there - but the meta tags
 * still stop the worst of the hue shifting.
 */
const D_BG = "#121a14"          // near-black, green-biased
const D_PANEL = "rgb(31,64,42)" // masthead: lifted so it reads as a block
const D_INK = "rgb(240,237,226)"
const D_INK_SOFT = "rgba(240,237,226,.62)"
const D_INK_FAINT = "rgba(240,237,226,.42)"
const D_RULE = "rgba(240,237,226,.22)"
const D_RULE_SOFT = "rgba(240,237,226,.12)"
const D_WASH = "rgba(240,237,226,.06)"

// [data-ogsc]/[data-ogsb] are what Outlook.com rewrites elements to in dark
// mode; without them it keeps the light colours and produces dark-on-dark.
const DARK_CSS = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .ae-bg, .ae-bg td { background-color: ${D_BG} !important; }
    .ae-panel { background-color: ${D_PANEL} !important; }
    .ae-wash { background-color: ${D_WASH} !important; }
    .ae-ink, .ae-ink a { color: ${D_INK} !important; }
    .ae-soft, .ae-soft a { color: ${D_INK_SOFT} !important; }
    .ae-faint, .ae-faint a { color: ${D_INK_FAINT} !important; }
    .ae-rule { border-color: ${D_RULE} !important; }
    .ae-rule-soft { border-color: ${D_RULE_SOFT} !important; }
  }
  [data-ogsc] .ae-bg { background-color: ${D_BG} !important; }
  [data-ogsc] .ae-panel { background-color: ${D_PANEL} !important; }
  [data-ogsc] .ae-wash { background-color: ${D_WASH} !important; }
  [data-ogsc] .ae-ink, [data-ogsc] .ae-ink a { color: ${D_INK} !important; }
  [data-ogsc] .ae-soft, [data-ogsc] .ae-soft a { color: ${D_INK_SOFT} !important; }
  [data-ogsc] .ae-faint, [data-ogsc] .ae-faint a { color: ${D_INK_FAINT} !important; }
  [data-ogsc] .ae-rule { border-color: ${D_RULE} !important; }
  [data-ogsc] .ae-rule-soft { border-color: ${D_RULE_SOFT} !important; }
`

// Multi-word family names MUST be quoted. An earlier version wrote
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
 *       slots: [{ time, title, detail, cost, address? }]
 *     }]
 *   },
 *   bookings: [{ group: "(1) Flights", items: [
 *     { label, detail, address?, links: [{ text, url }] }
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
 * `address` is new and optional throughout; nothing breaks without it.
 * ------------------------------------------------------------------ */

// ---- coercion + escaping -------------------------------------------------

const MAX_SHORT = 300
const MAX_LONG = 3000
const MAX_DAYS = 62
const MAX_SLOTS = 20
const MAX_GROUPS = 15
const MAX_ITEMS = 160
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

// A street address, rendered as a maps link. The href is built here from the
// escaped address text, never from a URL supplied by the caller, so this adds
// no new link surface.
function addressLine(raw, size) {
    const a = str(raw, MAX_SHORT)
    if (!a) return ""
    const px = size || 12
    const href =
        "https://www.google.com/maps/search/?api=1&query=" +
        encodeURIComponent(a)
    return `<div style="font-family:${SANS};font-size:${px}px;color:${G55};margin-top:4px;">
        <a href="${esc(href)}" style="color:${G55};text-decoration:none;border-bottom:1px solid ${RULE_SOFT};">${esc(a)}</a>
    </div>`
}

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
                        ${addressLine(s.address)}
                        ${cost ? `<div style="font-size:12px;color:${G55};margin-top:3px;">${cost}</div>` : ""}
                    </td></tr>`
                })
                .filter(Boolean)
                .join("")

            if (!slots) return ""

            // page-break-inside keeps a day whole when this is printed to PDF.
            return `<div class="ae-day" style="margin-bottom:26px;page-break-inside:avoid;">
                <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${GREEN};border-bottom:1px solid ${RULE};padding-bottom:7px;margin-bottom:6px;">${esc(str(d.title, 120))}</div>
                <table role="presentation" width="100%" style="border-collapse:collapse;">${slots}</table>
            </div>`
        })
        .filter(Boolean)
        .join("")

    const summary = esc(str(itin.summary, MAX_LONG))
    if (!dayHtml && !summary) return ""

    return `<div style="font-family:${SANS};">
        ${summary ? `<div style="font-size:14px;line-height:1.7;color:${G80};margin-bottom:26px;">${summary}</div>` : ""}
        ${dayHtml}
    </div>`
}

// withLinks:false renders labels as plain text. Retained for any future copy
// of this email that should carry no booking links.
function renderBookings(groups, opts) {
    const withLinks = !opts || opts.withLinks !== false
    const gs = arr(groups, MAX_GROUPS)
    if (!gs.length) return ""

    // Same hierarchy as the Book It tab on the site: a real booking action is
    // filled, a secondary option is outlined, and a Maps lookup is dashed --
    // so the shape of the button says what the words say. The attachment used
    // to render all three identically as underlined text.
    const pill = `display:inline-block;font-family:${SANS};font-size:10px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;text-decoration:none;padding:8px 13px;margin:0 8px 6px 0;`
    const styleFor = (i, muted) =>
        muted
            ? `${pill}border:1px dashed ${RULE};color:${G60};font-weight:500;`
            : i === 0
              ? `${pill}background:${GREEN};color:${BEIGE};border:1px solid ${GREEN};`
              : `${pill}border:1px solid ${RULE};color:${GREEN};`

    return gs
        .map((g) => {
            const rows = arr(g.items, MAX_ITEMS)
                .map((it) => {
                    const label = esc(str(it.label, MAX_SHORT))
                    if (!label) return ""
                    const detail = esc(str(it.detail, MAX_SHORT))
                    const addr = addressLine(it.address, 11)

                    const links = withLinks
                        ? arr(it.links, MAX_LINKS)
                              .map((l, i) => {
                                  const url = linkUrl(l.url)
                                  const text = esc(str(l.text, 60))
                                  if (!url || !text) return ""
                                  const muted = l.muted === true
                                  // The arrow earns its place on the action
                                  // button only; on every chip it was noise.
                                  const arrow = !muted && i === 0 ? " &rarr;" : ""
                                  return `<a href="${esc(url)}" style="${styleFor(i, muted)}">${text}${arrow}</a>`
                              })
                              .filter(Boolean)
                              .join("")
                        : ""

                    const gap = links || detail || addr ? "5px" : "0"
                    return `<div style="padding:13px 0;border-bottom:1px solid ${RULE_SOFT};font-family:${SANS};font-size:14px;color:${GREEN};page-break-inside:avoid;">
                        <div style="font-weight:500;margin-bottom:${gap};">${label}</div>
                        ${detail ? `<div style="font-size:12px;font-weight:300;color:${G60};">${detail}</div>` : ""}
                        ${addr}
                        ${links ? `<div style="margin-top:9px;">${links}</div>` : ""}
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
    const rows = arr(budget && budget.rows, MAX_ROWS)
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

    const t = budget && budget.total
    const foot = t
        ? `<tfoot><tr>
               <td style="padding:11px 0;font-weight:700;border-top:2px solid ${GREEN};">${esc(str(t.label, MAX_SHORT)) || "Total"}</td>
               <td style="padding:11px 0;font-weight:700;text-align:right;border-top:2px solid ${GREEN};">${esc(str(t.amount, 40))}</td>
           </tr></tfoot>`
        : ""

    const footnote = esc(str(budget && budget.footnote, MAX_LONG))

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

// The headline number, directly under the masthead. This is the first question
// anyone forwarded this email asks, and it used to sit at the very bottom
// under a table they had to read in order to answer it.
function renderHeadline(budget, trip) {
    const t = budget && budget.total
    const amount = esc(str(t && t.amount, 40))
    if (!amount) return ""
    const label = esc(str(t && t.label, MAX_SHORT)) || "Estimated total"
    const per = str(trip && trip.budgetPerPerson, 30)

    return `<div class="ae-wash" style="background:${WASH};padding:28px 40px;text-align:center;">
        <div class="ae-soft" style="font-family:${SANS};font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:${G55};margin-bottom:8px;">${label}</div>
        <div class="ae-ink" style="font-family:${SERIF};font-size:38px;font-weight:300;color:${GREEN};line-height:1;">${amount}</div>
        ${per ? `<div class="ae-soft" style="font-family:${SANS};font-size:12px;color:${G60};margin-top:10px;">Your budget was ${esc(per)} per person</div>` : ""}
    </div>`
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
        `<p class="ae-ink" style="font-family:${SERIF};font-size:22px;font-weight:300;color:${GREEN};margin:0 0 8px;">The Away Edit</p>`,
    ]

    const contact = [SITE_URL.replace(/^https?:\/\//, ""), CONTACT_EMAIL]
        .filter(Boolean)
        .map(esc)
        .join(" &nbsp;&middot;&nbsp; ")
    if (contact) bits.push(`<p class="ae-soft" style="${small}margin:0 0 10px;">${contact}</p>`)

    // CAN-SPAM: physical postal address.
    if (MAILING_ADDRESS)
        bits.push(`<p class="ae-soft" style="${small}margin:0 0 10px;">${esc(MAILING_ADDRESS)}</p>`)

    const links = []
    if (PRIVACY_URL)
        links.push(`<a href="${esc(PRIVACY_URL)}" style="color:${G60};">Privacy policy</a>`)
    if (UNSUBSCRIBE_URL)
        links.push(`<a href="${esc(UNSUBSCRIBE_URL)}" style="color:${G60};">Unsubscribe</a>`)
    if (links.length)
        bits.push(`<p class="ae-soft" style="${small}margin:0 0 10px;">${links.join(" &nbsp;&middot;&nbsp; ")}</p>`)

    bits.push(
        `<p class="ae-faint" style="font-family:${SANS};font-size:10px;color:${G40};margin:0;">You own every booking in this plan - The Away Edit books nothing on your behalf. Please verify all venues, prices and availability independently before confirming.</p>`
    )

    return `<div class="ae-rule" style="border-top:1px solid ${RULE};padding-top:32px;text-align:center;">${bits.join("")}</div>`
}

// ---- attachments ---------------------------------------------------------
//
// Three files, deliberately. The body is a covering note; these carry the
// trip. Keeping them out of the body is also what stops Gmail clipping a long
// trip at 102KB - a 21-day itinerary rendered inline exceeded that and was
// silently truncated mid-plan.
//
// They are HTML wearing Office extensions, which is how they have always
// worked: Word and Excel open them, and they carry the same escaped data as
// everything else, so there is no new injection surface. Note that phones
// handle .doc poorly - a real PDF would open cleanly everywhere, and pdfkit
// could produce one server-side without a headless browser if that becomes
// worth doing.

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

    // NOTE: Turnstile enforcement was removed, not forgotten. The client has
    // no widget and sends no token, so gating on TURNSTILE_SECRET_KEY meant
    // that setting that variable silently broke email for everyone with no
    // way to diagnose it. To re-enable: add the widget to AwayEdit.tsx, send
    // `turnstileToken` in the payload, and restore the siteverify call here.
    // Until then the rate limiter below (3/hour per IP, 100/day) is the guard.

    const trip = body.trip || {}
    const itin = body.itinerary || {}
    const title = str(itin.title, 200) || "Your Away Edit"
    const subtitle = str(itin.subtitle, 200)

    // Budget-per-person moved out of this line and into the headline block,
    // where it belongs next to the total it is being compared against.
    //
    // Destination and dates are deliberately NOT here: the subtitle directly
    // above already carries both, and printing them twice made the top of the
    // email read as a stutter. What is left is what the subtitle does not say.
    const metaLine = [
        str(trip.tripType),
        trip.tripLength ? `${str(trip.tripLength, 20)} nights` : "",
        trip.numberOfPeople ? `${str(trip.numberOfPeople, 20)} travelers` : "",
    ]
        .filter(Boolean)
        .map(esc)
        .join(" &nbsp;&middot;&nbsp; ")

    // ...unless there is no subtitle, in which case this is the only place
    // they would appear at all.
    const metaFull = subtitle
        ? metaLine
        : [str(trip.destination), str(trip.tripTiming), metaLine]
              .filter(Boolean)
              .map((s, i) => (i === 2 ? s : esc(s)))
              .join(" &nbsp;&middot;&nbsp; ")

    // Findable in a search box a year later: place first, dates in brackets.
    // Just the city - "Queenstown, New Zealand" plus a date range runs past
    // what a phone shows, and the country is never the part being searched for.
    const dest = str(trip.destination, 120)
    const city = dest.split(",")[0].trim() || dest
    const when = str(trip.tripTiming, 80)
    const subjectLine = city
        ? `Your trip to ${city}${when ? ` (${when})` : ""}`
        : `Your trip - ${title}`

    const headlineHtml = renderHeadline(body.budget, trip)
    const itinHtml = renderItinerary(itin)
    const bookingsHtml = renderBookings(body.bookings)
    const budgetHtml = renderBudget(body.budget)
    const checklistHtml = renderCategoryList(body.checklist)
    const packingHtml = renderCategoryList(body.packing)

    // ---- the three attachments, built from the same escaped data ----

    const fileBase = `The Away Edit - ${str(trip.destination) || title}`
        .replace(/[^\w\s.-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)

    const metaPlain = subtitle || metaLine
        ? `<p class="meta">${[esc(subtitle), metaLine].filter(Boolean).join(" &nbsp;&middot;&nbsp; ")}</p>`
        : ""

    // 1) Guest copy - itinerary and packing only, no booking links at all.
    //    The one meant to be forwarded to whoever is coming.
    const guestDoc = docWrap(
        `<h1>${esc(title)}</h1>${metaPlain}` +
            itinHtml +
            (packingHtml ? `<h2>Packing List</h2>${packingHtml}` : "")
    )

    // 2) Planning copy - the booking list and nothing else.
    //    It used to repeat the whole itinerary underneath, which made the two
    //    attachments near-duplicates of each other: the guest copy already IS
    //    the itinerary, and someone working through booking links does not
    //    want to scroll past fifteen days to reach them.
    const adminDoc = docWrap(
        `<h1>${esc(title)} - Booking Links</h1>${metaPlain}` +
            (bookingsHtml ? bookingsHtml : "") +
            (checklistHtml ? `<h2>Planning Checklist</h2>${checklistHtml}` : "")
    )

    const attachments = [
        { filename: `${fileBase} - Itinerary.doc`, content: toB64(guestDoc) },
        {
            filename: `${fileBase} - Booking Links.doc`,
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

    // Name the files in the covering note, so nobody has to open one to find
    // out which is which.
    const attachmentBlurb =
        attachments.length === 3
            ? "Three files: the itinerary to share with whoever is coming, a planning copy with every booking link, and the budget as a spreadsheet."
            : "The itinerary to share with whoever is coming, and a planning copy with every booking link."

    const note = `font-family:${SANS};font-size:14px;line-height:1.75;color:${G80};margin:0 0 16px;`

    const emailHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- These two are what stop iOS Mail and Apple Mail force-inverting the
       palette. Without them a dark green gets algorithmically flipped and
       comes out teal. They must be present even if DARK_CSS is stripped. -->
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${esc(title)}</title>
  <style>${DARK_CSS}</style>
</head>
<body class="ae-bg" style="margin:0;padding:0;background-color:${BEIGE};font-family:${SERIF};">
  <div class="ae-bg" style="max-width:640px;margin:0 auto;padding:0;background-color:${BEIGE};">

    <div class="ae-panel" style="background:${GREEN};padding:48px 40px 40px;text-align:center;">
      <p style="font-family:${SANS};font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(249,247,239,0.6);margin:0 0 12px;">Your Curated Itinerary</p>
      <h1 style="font-family:${SERIF};font-weight:300;font-size:42px;color:${BEIGE};margin:0;letter-spacing:0.04em;">The Away Edit</h1>
    </div>

    <div style="padding:36px 40px 0;text-align:center;">
      <div class="ae-ink" style="font-family:${SERIF};font-size:26px;font-weight:400;color:${GREEN};line-height:1.3;">${esc(title)}</div>
      ${subtitle ? `<div class="ae-soft" style="font-family:${SANS};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${G55};margin-top:10px;">${esc(subtitle)}</div>` : ""}
    </div>

    ${
        metaFull
            ? `<div style="padding:14px 40px 10px;text-align:center;">
                   <p class="ae-soft" style="font-family:${SANS};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${G60};margin:0;line-height:1.9;">${metaFull}</p>
               </div>`
            : ""
    }

    ${headlineHtml}

    <div style="padding:34px 40px 40px;">
      <p class="ae-ink" style="${note}">Your trip is attached. ${attachmentBlurb}</p>
      <p class="ae-ink" style="${note}">Every booking is yours to make &#8212; The Away Edit reserves nothing on your behalf, so check prices, opening hours and availability before you commit to anything.</p>
      <p class="ae-soft" style="font-family:${SANS};font-size:13px;line-height:1.7;color:${G60};margin:0 0 34px;">Happy travels.</p>

      ${renderFooter()}
    </div>
  </div>
</body>
</html>`

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
                subject: subjectLine,
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
