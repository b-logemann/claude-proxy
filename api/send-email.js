// api/send-email.js
import { Resend } from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

// Must be a domain you've verified in Resend (or use onboarding@resend.dev for testing).
const FROM = "The Away Edit <hello@theawayeditco.com>"

const GREEN = "rgb(38,78,51)"
const BEIGE = "rgb(249,247,239)"

export default async function handler(req, res) {
    // ── CORS ──
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") return res.status(200).end()
    if (req.method !== "POST")
        return res.status(405).json({ error: "Method not allowed" })

    try {
        const {
            email,
            itineraryTitle,
            chosenItineraryHTML,
            todoList,
            packingListHTML,
            budgetHTML,
            destination,
            tripType,
            tripTiming,
            tripLength,
            numberOfPeople,
        } = req.body || {}

        if (!email || !email.includes("@"))
            return res.status(400).json({ error: "A valid email is required." })

        const safe = (v) => (v == null ? "" : String(v))
        // Remove every <a>…</a> anchor (the booking links) for the guest copy.
        const stripLinks = (html) =>
            safe(html).replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
        const toB64 = (str) => Buffer.from(str, "utf-8").toString("base64")

        const title = safe(itineraryTitle) || "Your Trip"
        const dest = safe(destination)
        const metaLine = [
            dest,
            safe(tripType),
            tripLength ? `${tripLength} days` : "",
            numberOfPeople ? `${numberOfPeople} people` : "",
            safe(tripTiming),
        ]
            .filter(Boolean)
            .join("  ·  ")

        // Clean base for filenames (strip characters Windows/macOS dislike).
        const fileBase = `The Away Edit - ${dest || title}`
            .replace(/[^\w\s.-]/g, "")
            .replace(/\s+/g, " ")
            .trim()

        // ── Word-openable .doc wrapper (HTML with brand styling) ──
        const docWrap = (innerHTML) => `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8" /><title>The Away Edit</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: ${GREEN}; background: #fff; padding: 32px; line-height: 1.6; }
  h1 { font-weight: 300; font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; border-bottom: 1px solid rgba(38,78,51,0.3); padding-bottom: 6px; margin: 28px 0 14px; font-family: Arial, sans-serif; }
  .brand { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(38,78,51,0.6); font-family: Arial, sans-serif; }
  .meta { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(38,78,51,0.6); font-family: Arial, sans-serif; margin: 0 0 20px; }
  .itinerary, .partial-guide { border: none; padding: 0; }
  .day-title { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 10px; font-family: Arial, sans-serif; }
  .time-label { font-size: 10px; text-transform: uppercase; background: rgba(38,78,51,0.1); padding: 2px 8px; border-radius: 10px; font-family: Arial, sans-serif; }
  .time-content, .guide-item-detail { font-size: 13px; }
  .cost-block { background: rgba(38,78,51,0.07); padding: 14px 18px; margin-top: 18px; }
  table { width: 100%; border-collapse: collapse; }
  .disclaimer { font-size: 10px; color: rgba(38,78,51,0.55); border-top: 1px solid rgba(38,78,51,0.15); padding-top: 10px; margin-top: 28px; font-family: Arial, sans-serif; }
</style></head>
<body>
  <p class="brand">The Away Edit</p>
  ${innerHTML}
  <p class="disclaimer">Recommendations are curated suggestions and may have changed — always verify venues, prices, and availability before booking.</p>
</body></html>`

        // 1) GUEST itinerary — booking links removed, safe to forward to guests.
        const guestDoc = docWrap(
            `<h1>${title}</h1>${metaLine ? `<p class="meta">${metaLine}</p>` : ""}` +
                stripLinks(chosenItineraryHTML) +
                (packingListHTML
                    ? `<h2>Packing List</h2>${safe(packingListHTML)}`
                    : "")
        )

        // 2) ADMIN copy — keeps every booking link, plus the planning checklist.
        const adminDoc = docWrap(
            `<h1>${title} — Planning Copy</h1>${metaLine ? `<p class="meta">${metaLine}</p>` : ""}` +
                (todoList ? `<h2>Planning Checklist</h2>${safe(todoList)}` : "") +
                `<h2>Itinerary with Booking Links</h2>` +
                safe(chosenItineraryHTML)
        )

        // 3) BUDGET — Excel-openable .xls (HTML table that Excel imports cleanly).
        const budgetXls = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Budget</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head><body><h3>The Away Edit — ${dest || title} Budget (per person)</h3>${safe(budgetHTML)}</body></html>`

        // ── Assemble attachments ──
        const attachments = [
            {
                filename: `${fileBase} - Itinerary.doc`,
                content: toB64(guestDoc),
            },
            {
                filename: `${fileBase} - Planning & Booking Links.doc`,
                content: toB64(adminDoc),
            },
        ]
        if (budgetHTML)
            attachments.push({
                filename: `${fileBase} - Budget.xls`,
                content: toB64(budgetXls),
            })

        // ── Short branded email body (the documents are attached) ──
        const emailHTML = `
<div style="font-family:Georgia,serif;color:${GREEN};background:${BEIGE};padding:32px;max-width:560px;margin:0 auto;">
  <p style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(38,78,51,0.6);font-family:Arial,sans-serif;">The Away Edit</p>
  <h1 style="font-weight:300;font-size:26px;margin:4px 0 16px;">Your ${dest || "trip"} plans are here</h1>
  <p style="font-size:14px;line-height:1.7;font-family:Arial,sans-serif;font-weight:300;">Everything's attached and ready to go:</p>
  <ul style="font-size:14px;line-height:1.8;font-family:Arial,sans-serif;font-weight:300;">
    <li><strong>Itinerary</strong> — a clean copy you can forward to your group.</li>
    <li><strong>Planning &amp; Booking Links</strong> — your version, with every booking link and the planning checklist.</li>
    ${budgetHTML ? "<li><strong>Budget</strong> — an editable spreadsheet.</li>" : ""}
  </ul>
  <p style="font-size:12px;color:rgba(38,78,51,0.6);line-height:1.7;font-family:Arial,sans-serif;border-top:1px solid rgba(38,78,51,0.15);padding-top:14px;margin-top:24px;">
    Some links are affiliate links — we may earn a small commission, at no extra cost to you. Always verify venues, prices, and availability before booking.
  </p>
  <p style="font-size:12px;letter-spacing:0.1em;color:rgba(38,78,51,0.6);font-family:Arial,sans-serif;">theawayeditco.com</p>
</div>`

        await resend.emails.send({
            from: FROM,
            to: email,
            subject: `Your ${dest || "trip"} plans from The Away Edit`,
            html: emailHTML,
            attachments,
        })

        return res.status(200).json({ success: true })
    } catch (err) {
        console.error("send-email error:", err)
        return res
            .status(500)
            .json({ success: false, error: err.message || "Send failed" })
    }
}
