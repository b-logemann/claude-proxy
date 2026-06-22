export const maxDuration = 60;

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
    bookingLinksHTML,
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

      <!-- Itinerary section -->
      ${chosenItineraryHTML ? `
      <div style="margin-bottom:48px;">
        <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${brandGreen};margin:0 0 20px;border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:10px;">Your Itinerary</p>
        <div style="font-family:Georgia,serif;font-size:15px;color:${brandGreen};line-height:1.8;">
          ${chosenItineraryHTML
            .replace(/class="itinerary"/g, `style="margin-bottom:24px;"`)
            .replace(/class="option-label"/g, `style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(38,78,51,0.6);margin-bottom:8px;"`)
            .replace(/class="itinerary-title"/g, `style="font-family:Georgia,serif;font-size:26px;font-weight:300;color:${brandGreen};margin:0 0 12px;"`)
            .replace(/class="itinerary-summary"/g, `style="font-size:14px;font-family:Helvetica Neue,sans-serif;font-weight:300;color:${brandGreen};line-height:1.8;margin-bottom:24px;"`)
            .replace(/class="day-block"/g, `style="border-left:2px solid ${brandGreen};padding-left:20px;margin-bottom:24px;"`)
            .replace(/class="day-title"/g, `style="font-family:Helvetica Neue,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${brandGreen};margin-bottom:14px;"`)
            .replace(/class="time-label"/g, `style="display:inline-block;font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;background:rgba(38,78,51,0.1);color:${brandGreen};padding:2px 10px;border-radius:20px;margin-bottom:6px;"`)
            .replace(/class="time-content"/g, `style="font-size:14px;color:${brandGreen};line-height:1.7;font-family:Helvetica Neue,sans-serif;font-weight:300;margin-bottom:12px;"`)
            .replace(/class="time-block"/g, `style="margin-bottom:14px;"`)
            .replace(/class="cost-block"/g, `style="background:rgba(38,78,51,0.07);padding:18px 22px;margin-top:24px;border:1px solid rgba(38,78,51,0.15);"`)
            .replace(/class="cost-title"/g, `style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${brandGreen};margin-bottom:8px;font-weight:600;"`)
            .replace(/class="cost-content"/g, `style="font-size:13px;color:${brandGreen};line-height:1.8;font-family:Helvetica Neue,sans-serif;font-weight:300;"`)
          }
        </div>
        <p style="font-family:Helvetica Neue,sans-serif;font-size:11px;color:rgba(38,78,51,0.5);line-height:1.6;margin-top:16px;border-top:1px solid rgba(38,78,51,0.12);padding-top:12px;">AI-generated itinerary. All venues, prices, and availability should be verified independently before booking.</p>
      </div>
      ` : ""}

      <!-- Packing list section -->
      ${packingListHTML ? `
      <div style="margin-bottom:48px;">
        <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${brandGreen};margin:0 0 20px;border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:10px;">Your Packing List</p>
        <div style="font-family:Helvetica Neue,sans-serif;font-size:14px;color:${brandGreen};line-height:1.9;font-weight:300;">
          ${packingListHTML
            .replace(/class="pack-section"/g, `style="margin-bottom:20px;"`)
            .replace(/class="pack-category"/g, `style="font-family:Helvetica Neue,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${brandGreen};border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:6px;margin-bottom:10px;"`)
            .replace(/class="pack-list"/g, `style="padding-left:18px;margin:0;"`)
            .replace(/class="pack-item"/g, `style="font-size:14px;color:${brandGreen};line-height:1.9;font-family:Helvetica Neue,sans-serif;font-weight:300;"`)
          }
        </div>
      </div>
      ` : ""}

      <!-- Planning checklist section -->
      ${todoList ? `
      <div style="margin-bottom:48px;">
        <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${brandGreen};margin:0 0 20px;border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:10px;">Your Planning Checklist</p>
        <div style="font-family:Helvetica Neue,sans-serif;font-size:14px;color:${brandGreen};line-height:1.9;font-weight:300;">
          ${todoList
            .replace(/class="todo-section"/g, `style="margin-bottom:24px;"`)
            .replace(/class="todo-category"/g, `style="font-family:Helvetica Neue,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${brandGreen};border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:6px;margin-bottom:10px;"`)
            .replace(/class="todo-list"/g, `style="padding-left:18px;margin:0;"`)
            .replace(/class="todo-item"/g, `style="font-size:14px;color:${brandGreen};line-height:1.9;font-family:Helvetica Neue,sans-serif;font-weight:300;"`)
            .replace(/class="todo-link"/g, `style="color:${brandGreen};font-weight:500;"`)
          }
        </div>
      </div>
      ` : ""}

      <!-- Budget section -->
      ${budgetHTML ? `
      <div style="margin-bottom:48px;">
        <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${brandGreen};margin:0 0 20px;border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:10px;">Your Budget Overview</p>
        <div style="font-family:Helvetica Neue,sans-serif;font-size:14px;color:${brandGreen};">
          ${budgetHTML}
        </div>
        <p style="font-family:Helvetica Neue,sans-serif;font-size:11px;color:rgba(38,78,51,0.5);margin-top:12px;">Download your editable budget spreadsheet from the link in this email.</p>
      </div>
      ` : ""}

      <!-- Things to do now / booking links section -->
      ${bookingLinksHTML ? `
      <div style="margin-bottom:48px;">
        <p style="font-family:Helvetica Neue,sans-serif;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${brandGreen};margin:0 0 20px;border-bottom:1px solid rgba(38,78,51,0.2);padding-bottom:10px;">Things To Do Now</p>
        <div style="font-family:Helvetica Neue,sans-serif;font-size:14px;color:${brandGreen};">
          ${bookingLinksHTML}
        </div>
        <p style="font-family:Helvetica Neue,sans-serif;font-size:11px;color:rgba(38,78,51,0.5);margin-top:12px;line-height:1.6;">These contain affiliate links — we may earn a small commission if you book through them, at no extra cost to you.</p>
      </div>
      ` : ""}

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

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL,
        to: email,
        subject: `Your Away Edit — ${itineraryTitle || "Your Perfect Trip"}`,
        html: emailHTML,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      return res.status(500).json({ error: data.message || "Failed to send email" })
    }

    res.status(200).json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message || "Unexpected error" })
  }
}
