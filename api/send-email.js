// api/send-email.js
export const maxDuration = 60

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")

    if (req.method === "OPTIONS") return res.status(200).end()
    if (req.method !== "POST") return res.status(405).end()

    const {
        email,
        itineraryTitle,
        chosenItineraryHTML,
        todoList,
        packingListHTML,
        budgetHTML,
        reservationsHTML,
        destination,
        tripType,
        tripTiming,
        tripLength,
        numberOfPeople,
        budgetPerPerson,
    } = req.body

    if (!email) {
        return res.status(400).json({ error: "Missing email address" })
    }

    const brandGreen = "rgb(38, 78, 51)"
    const brandBeige = "rgb(249, 247, 239)"

    const emailHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${itineraryTitle || "Your Away Edit"}</title>
</head>
<body style="margin:0;padding:0;background-color:${brandBeige};font-family:Georgia,serif;">
  <div style="max-width:640px;margin:0 auto;padding:0;">

    <!-- Header -->
    <div style="background:${brandGreen};padding:48px 40px 40px;text-align:center;">
      <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(249,247,239,0.6);margin:0 0 12px;">Your Curated Itinerary</p>
      <h1 style="font-family:Georgia,serif;font-weight:300;font-size:42px;color:${brandBeige};margin:0;letter-spacing:0.04em;">The Away Edit</h1>
    </div>

    <!-- Trip summary bar -->
    <div style="background:rgba(38,78,51,0.08);padding:20px 40px;border-bottom:1px solid rgba(38,78,51,0.15);">
      <p style="font-family:Helvetica Neue,sans-serif;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${brandGreen};margin:0;">
        ${destination || ""} &nbsp;·&nbsp; ${tripType || ""} &nbsp;·&nbsp; ${tripLength || ""} days &nbsp;·&nbsp; ${tripTiming || ""} &nbsp;·&nbsp; ${numberOfPeople || ""} people &nbsp;·&nbsp; ${budgetPerPerson || ""}/person
      </p>
    </div>

    <div style="padding:40px;">

      <!-- Cover note -->
      <div style="margin-bottom:40px;">
        <p style="font-family:Helvetica Neue,sans-serif;font-size:14px;color:${brandGreen};line-height:1.7;font-weight:300;margin:0 0 14px;">Everything for your trip is attached and ready to go:</p>
        <ul style="font-family:Helvetica Neue,sans-serif;font-size:14px;color:${brandGreen};line-height:1.8;font-weight:300;margin:0;padding-left:20px;">
          <li><strong>Itinerary</strong> — a clean copy you can forward to your group.</li>
          <li><strong>Planning &amp; Booking Links</strong> — your version, with every booking link and the planning checklist.</li>
          ${budgetHTML ? "<li><strong>Budget</strong> — an editable spreadsheet.</li>" : ""}
        </ul>
      </div>

      <!-- Itinerary section -->
      ${
          chosenItineraryHTML
              ? `
      <div style="margin-bottom:48px;">
        <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${brandGreen};margin:0 0 20px;border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:10px;">Your Itinerary</p>
        <div style="font-family:Georgia,serif;font-size:15px;color:${brandGreen};line-height:1.8;">
          ${chosenItineraryHTML
              .replace(/class="itinerary"/g, `style="margin-bottom:24px;"`)
              .replace(
                  /class="option-label"/g,
                  `style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(38,78,51,0.6);margin-bottom:8px;"`
              )
              .replace(
                  /class="itinerary-title"/g,
                  `style="font-family:Georgia,serif;font-size:26px;font-weight:300;color:${brandGreen};margin:0 0 12px;"`
              )
              .replace(
                  /class="itinerary-summary"/g,
                  `style="font-size:14px;font-family:Helvetica Neue,sans-serif;font-weight:300;color:${brandGreen};line-height:1.8;margin-bottom:24px;"`
              )
              .replace(
                  /class="day-block"/g,
                  `style="border-left:2px solid ${brandGreen};padding-left:20px;margin-bottom:24px;"`
              )
              .replace(
                  /class="day-title"/g,
                  `style="font-family:Helvetica Neue,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${brandGreen};margin-bottom:14px;"`
              )
              .replace(
                  /class="time-label"/g,
                  `style="display:inline-block;font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;background:rgba(38,78,51,0.1);color:${brandGreen};padding:2px 10px;border-radius:20px;margin-bottom:6px;"`
              )
              .replace(
                  /class="time-content"/g,
                  `style="font-size:14px;color:${brandGreen};line-height:1.7;font-family:Helvetica Neue,sans-serif;font-weight:300;margin-bottom:12px;"`
              )
              .replace(/class="time-block"/g, `style="margin-bottom:14px;"`)
              .replace(
                  /class="cost-block"/g,
                  `style="background:rgba(38,78,51,0.07);padding:18px 22px;margin-top:24px;border:1px solid rgba(38,78,51,0.15);"`
              )
              .replace(
                  /class="cost-title"/g,
                  `style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${brandGreen};margin-bottom:8px;font-weight:600;"`
              )
              .replace(
                  /class="cost-content"/g,
                  `style="font-size:13px;color:${brandGreen};line-height:1.8;font-family:Helvetica Neue,sans-serif;font-weight:300;"`
              )}
        </div>
        <p style="font-family:Helvetica Neue,sans-serif;font-size:11px;color:rgba(38,78,51,0.5);line-height:1.6;margin-top:16px;border-top:1px solid rgba(38,78,51,0.12);padding-top:12px;">AI-generated itinerary. All venues, prices, and availability should be verified independently before booking.</p>
      </div>
      `
              : ""
      }

      <!-- Reservations & Bookings -->
      ${
          reservationsHTML
              ? `
      <div style="margin-bottom:48px;">
        <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${brandGreen};margin:0 0 20px;border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:10px;">Reservations &amp; Bookings</p>
        ${reservationsHTML}
      </div>
      `
              : ""
      }

      <!-- Footer -->
      <div style="border-top:1px solid rgba(38,78,51,0.2);padding-top:32px;text-align:center;">
        <p style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:${brandGreen};margin:0 0 8px;">The Away Edit</p>
        <p style="font-family:Helvetica Neue,sans-serif;font-size:11px;color:rgba(38,78,51,0.5);margin:0 0 16px;">theawayeditco.com &nbsp;·&nbsp; theawayeditco@gmail.com</p>
        <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;color:rgba(38,78,51,0.4);margin:0;">Please verify all bookings and availability independently before confirming.</p>
      </div>

    </div>
  </div>
  </body>
</html>
  `

    // ── Build the attachments (no extra packages — .doc/.xls are HTML the
    //    Office apps open natively) ──
    const safe = (v) => (v == null ? "" : String(v))
    const stripLinks = (html) =>
        safe(html).replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
    const toB64 = (str) => Buffer.from(str, "utf-8").toString("base64")

    const fileBase = `The Away Edit - ${destination || itineraryTitle || "Trip"}`
        .replace(/[^\w\s.-]/g, "")
        .replace(/\s+/g, " ")
        .trim()

    const metaLine = [
        safe(destination),
        safe(tripType),
        tripLength ? `${tripLength} days` : "",
        numberOfPeople ? `${numberOfPeople} people` : "",
        safe(tripTiming),
    ]
        .filter(Boolean)
        .join("  ·  ")

    const docWrap = (inner) => `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8" /><title>The Away Edit</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: ${brandGreen}; padding: 32px; line-height: 1.6; }
  h1 { font-weight: 300; font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; border-bottom: 1px solid rgba(38,78,51,0.3); padding-bottom: 6px; margin: 28px 0 14px; font-family: Arial, sans-serif; }
  .brand { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(38,78,51,0.6); font-family: Arial, sans-serif; }
  .meta { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(38,78,51,0.6); font-family: Arial, sans-serif; margin: 0 0 20px; }
  .day-title { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 10px; font-family: Arial, sans-serif; }
  .day-block { border-left: 2px solid rgba(38,78,51,0.4); padding-left: 16px; margin-bottom: 18px; }
  .time-label { font-size: 10px; text-transform: uppercase; background: rgba(38,78,51,0.1); padding: 2px 8px; border-radius: 10px; font-family: Arial, sans-serif; }
  .time-content, .guide-item-detail, .pack-item, .todo-item { font-size: 13px; }
  .guide-section-title, .pack-category, .todo-category { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin: 16px 0 8px; font-family: Arial, sans-serif; }
  .cost-block { background: rgba(38,78,51,0.07); padding: 14px 18px; margin-top: 18px; }
  table { width: 100%; border-collapse: collapse; }
  .disclaimer { font-size: 10px; color: rgba(38,78,51,0.55); border-top: 1px solid rgba(38,78,51,0.15); padding-top: 10px; margin-top: 28px; font-family: Arial, sans-serif; }
</style></head>
<body>
  <p class="brand">The Away Edit</p>
  ${inner}
  <p class="disclaimer">Recommendations are curated suggestions and may have changed — always verify venues, prices, and availability before booking.</p>
</body></html>`

    // 1) GUEST itinerary — booking links removed, safe to forward.
    const guestDoc = docWrap(
        `<h1>${safe(itineraryTitle) || "Your Trip"}</h1>${metaLine ? `<p class="meta">${metaLine}</p>` : ""}` +
            stripLinks(chosenItineraryHTML) +
            (packingListHTML
                ? `<h2>Packing List</h2>${safe(packingListHTML)}`
                : "")
    )

    // 2) ADMIN copy — keeps every booking link + the planning checklist.
    const adminDoc = docWrap(
        `<h1>${safe(itineraryTitle) || "Your Trip"} — Planning Copy</h1>${metaLine ? `<p class="meta">${metaLine}</p>` : ""}` +
            (reservationsHTML
                ? `<h2>Reservations &amp; Bookings</h2>${safe(reservationsHTML)}`
                : "") +
            (todoList ? `<h2>Planning Checklist</h2>${safe(todoList)}` : "") +
            `<h2>Itinerary</h2>${safe(chosenItineraryHTML)}`
    )

    // 3) BUDGET — Excel-openable .xls.
    const budgetXls = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Budget</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head><body><h3>The Away Edit — ${safe(destination) || safe(itineraryTitle)} Budget (per person)</h3>${safe(budgetHTML)}</body></html>`

    const attachments = [
        { filename: `${fileBase} - Itinerary.doc`, content: toB64(guestDoc) },
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

    try {
        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                from: process.env.FROM_EMAIL,
                to: email,
                subject: `Your Away Edit — ${itineraryTitle || "Your Perfect Trip"}`,
                html: emailHTML,
                attachments,
            }),
        })

        const data = await response.json()

        if (!response.ok) {
            return res
                .status(500)
                .json({ error: data.message || "Failed to send email" })
        }

        res.status(200).json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message || "Unexpected error" })
    }
}
