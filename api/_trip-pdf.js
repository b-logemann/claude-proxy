// api/_trip-pdf.js - the trip as a PDF, built from the same structured,
// length-capped data send-email.js already receives. Nothing here accepts
// HTML: every string is plain text drawn onto the page, and every link is
// scheme-checked by the caller's linkUrl() before it reaches us.
//
// Why pdf-lib and not pdfkit: pdf-lib carries the 14 standard PDF fonts inside
// its own JavaScript, so it reads no files at run time. pdfkit loads .afm font
// files from node_modules, which Vercel's file tracing tends to leave out of
// the function bundle ("ENOENT Helvetica.afm"). No headless browser either.
//
// The standard fonts only cover Windows-1252 (Latin-1 plus curly quotes and
// dashes), so clean() maps the arrows and ticks the client uses to plain
// equivalents and drops anything else the font cannot draw, rather than throw.
//
// The underscore keeps Vercel from exposing this file as an /api route.

import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from "pdf-lib"

const GREEN = rgb(38 / 255, 78 / 255, 51 / 255)
const BEIGE = rgb(249 / 255, 247 / 255, 239 / 255)
const SOFT = rgb(0.4, 0.5, 0.43) // 80% green on white, same role as SOFT in the email
const RULE = rgb(0.82, 0.86, 0.83)
const WASH = rgb(0.94, 0.95, 0.93)

// US Letter. A4 readers print it fine with "fit to page".
const W = 612
const H = 792
const M = 50 // margin
const TIME_COL = 74 // the narrow time column beside each item

const WINANSI_EXTRA = "\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178"

function clean(v) {
    const s = String(v == null ? "" : v)
        .replace(/\u2192/g, "to")
        .replace(/\u2190/g, "from")
        .replace(/[\u2197\u2198]/g, "")
        .replace(/\u2713|\u2714/g, "")
        .replace(/\u2212/g, "-")
        .replace(/\u00a0/g, " ")
        .replace(/[\r\n\t]+/g, " ")
    let out = ""
    for (const ch of s) {
        const c = ch.codePointAt(0)
        if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.includes(ch))
            out += ch
    }
    return out.replace(/\s{2,}/g, " ").trim()
}

// Greedy word wrap against the real glyph widths.
function wrap(text, font, size, width) {
    const words = clean(text).split(" ").filter(Boolean)
    const lines = []
    let line = ""
    for (const w of words) {
        const next = line ? line + " " + w : w
        if (font.widthOfTextAtSize(next, size) <= width) {
            line = next
            continue
        }
        if (line) lines.push(line)
        // A single word wider than the column (a long URL-ish name): hard-cut.
        let word = w
        while (font.widthOfTextAtSize(word, size) > width && word.length > 1) {
            let i = word.length
            while (i > 1 && font.widthOfTextAtSize(word.slice(0, i), size) > width) i--
            lines.push(word.slice(0, i))
            word = word.slice(i)
        }
        line = word
    }
    if (line) lines.push(line)
    return lines
}

function addLink(doc, page, x, y, w, h, url) {
    try {
        const annot = doc.context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: [x, y, x + w, y + h],
            Border: [0, 0, 0],
            A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
        })
        const ref = doc.context.register(annot)
        const key = PDFName.of("Annots")
        const existing = page.node.lookup(key)
        if (existing && existing.push) existing.push(ref)
        else page.node.set(key, doc.context.obj([ref]))
    } catch {
        // A link that cannot be added is still printed as text.
    }
}

/**
 * data = {
 *   title, subtitle, meta,                 // strings
 *   total: { label, amount }, budgetLine,  // strings
 *   bookFirst: "Flights . Hotel . ...",    // string or ""
 *   days: [{ title, slots: [{ time, title, detail, cost, area, booked,
 *                             url, linkText }] }]   // url already checked
 * }
 * Returns a Uint8Array.
 */
export async function buildTripPdf(data) {
    const doc = await PDFDocument.create()
    doc.setTitle(clean(data.title) || "Your trip")
    doc.setAuthor("The Away Edit")
    doc.setCreator("The Away Edit")

    const sans = await doc.embedFont(StandardFonts.Helvetica)
    const bold = await doc.embedFont(StandardFonts.HelveticaBold)
    const serif = await doc.embedFont(StandardFonts.TimesRoman)

    let page
    let y
    const pages = []
    const newPage = () => {
        page = doc.addPage([W, H])
        pages.push(page)
        y = H - M
    }
    const ensure = (h) => {
        if (y - h < M + 20) newPage()
    }
    const text = (t, x, size, font, color, opts) => {
        const s = clean(t)
        if (!s) return 0
        page.drawText(s, { x, y, size, font, color })
        const w = font.widthOfTextAtSize(s, size)
        if (opts && opts.url) {
            page.drawLine({
                start: { x, y: y - 1.5 },
                end: { x: x + w, y: y - 1.5 },
                thickness: 0.6,
                color,
            })
            addLink(doc, page, x, y - 3, w, size + 3, opts.url)
        }
        return w
    }
    const caps = (t) => clean(t).toUpperCase()

    newPage()

    // ---- masthead ----
    const bandH = 96
    page.drawRectangle({ x: 0, y: H - bandH, width: W, height: bandH, color: GREEN })
    y = H - 34
    text("THE AWAY EDIT", M, 8, bold, BEIGE)
    y = H - 66
    const titleLines = wrap(data.title, serif, 24, W - 2 * M).slice(0, 1)
    text(titleLines[0] || "Your trip", M, 24, serif, BEIGE)
    y = H - 84
    text(caps(data.subtitle), M, 8, sans, BEIGE)
    y = H - bandH - 26

    if (data.meta) {
        text(caps(data.meta), M, 8, sans, SOFT)
        y -= 18
    }

    // ---- the number ----
    if (data.total && data.total.amount) {
        const boxH = data.budgetLine ? 54 : 42
        page.drawRectangle({ x: M, y: y - boxH + 12, width: W - 2 * M, height: boxH, color: WASH })
        y -= 6
        const aw = text(data.total.amount, M + 14, 22, serif, GREEN)
        text(data.total.label || "Estimated total", M + 22 + aw, 9, sans, SOFT)
        if (data.budgetLine) {
            y -= 16
            text(data.budgetLine, M + 14, 9, sans, SOFT)
        }
        y -= boxH - (data.budgetLine ? 16 : 6) + 4
    }

    // ---- book first ----
    if (data.bookFirst) {
        y -= 4
        text("BOOK FIRST", M, 7.5, bold, GREEN)
        const lines = wrap(data.bookFirst, sans, 9.5, W - 2 * M - TIME_COL)
        lines.forEach((l, i) => {
            if (i) y -= 13
            text(l, M + TIME_COL, 9.5, sans, GREEN)
        })
        y -= 22
    }

    // ---- the days ----
    const bodyW = W - 2 * M - TIME_COL
    const slotLayout = (s) => {
        const titleLines = wrap(s.title, bold, 10.5, bodyW)
        const metaBits = [s.area, s.cost].map(clean).filter(Boolean)
        const detailLines = s.detail ? wrap(s.detail, sans, 9, bodyW) : []
        const h =
            titleLines.length * 13 +
            (metaBits.length ? 12 : 0) +
            detailLines.length * 11.5 +
            (s.url ? 13 : 0) +
            8
        return { titleLines, metaBits, detailLines, h }
    }

    for (const d of data.days || []) {
        const slots = (d.slots || []).filter((s) => clean(s.title))
        if (!slots.length) continue
        const laid = slots.map(slotLayout)
        const dayH = 26 + laid.reduce((a, l) => a + l.h, 0)
        // Keep a day whole when it fits on one page; otherwise just start it
        // with room for its heading and first item.
        const fitsOnePage = dayH <= H - 2 * M - 40
        ensure(fitsOnePage ? dayH : 26 + laid[0].h)

        page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.8, color: RULE })
        y -= 6
        text(caps(d.title), M, 8.5, bold, GREEN)
        y -= 18

        slots.forEach((s, i) => {
            const l = laid[i]
            ensure(l.h)
            const top = y
            text(caps(s.time), M, 7.5, bold, s.booked ? GREEN : SOFT)
            l.titleLines.forEach((t, j) => {
                if (j) y -= 13
                text(t, M + TIME_COL, 10.5, bold, GREEN)
            })
            if (s.booked) {
                const lastW = bold.widthOfTextAtSize(clean(l.titleLines[l.titleLines.length - 1] || ""), 10.5)
                const bx = M + TIME_COL + lastW + 6
                if (bx + 40 < W - M) {
                    page.drawRectangle({ x: bx, y: y - 2, width: 38, height: 11, borderColor: GREEN, borderWidth: 0.7 })
                    text("BOOKED", bx + 4, 6.5, bold, GREEN)
                }
            }
            if (l.metaBits.length) {
                y -= 12
                text(l.metaBits.join(" \u00b7 "), M + TIME_COL, 8.5, sans, SOFT)
            }
            l.detailLines.forEach((t) => {
                y -= 11.5
                text(t, M + TIME_COL, 9, sans, GREEN)
            })
            if (s.url) {
                y -= 13
                text((clean(s.linkText) || "Open") + " ->", M + TIME_COL, 8.5, bold, GREEN, { url: s.url })
            }
            y = Math.min(y, top - l.h + 8) - 8
        })
        y -= 10
    }

    // ---- footer on every page ----
    const foot =
        "You own every booking in this plan - The Away Edit books nothing on your behalf. Verify venues, prices and availability before confirming."
    pages.forEach((p, i) => {
        p.drawText(clean(foot), { x: M, y: 28, size: 6.5, font: sans, color: SOFT })
        const n = `${i + 1} / ${pages.length}`
        p.drawText(n, { x: W - M - sans.widthOfTextAtSize(n, 7), y: 28, size: 7, font: sans, color: SOFT })
    })

    return await doc.save()
}
