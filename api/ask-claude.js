// api/ask-claude.js
import { withGuard } from "./_guard.js"
import { meter, claudeUsage } from "./_meter.js"

export const maxDuration = 60

// Output is already bounded by max_tokens. Input was not bounded at all, so a
// caller could send an arbitrarily large prompt and you pay for every token of
// it. Set this above your largest real prompt - the vibe-rework call, which
// carries the whole itinerary, is the one to measure. The console.warn below
// tells you when you are close, so you can raise it on evidence rather than
// guessing.
const MAX_INPUT_CHARS = 100000

// One place to change the model; the stats page prices tokens by this name.
const MODEL = "claude-sonnet-4-6"

async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).end()

    const { userInput } = req.body || {}
    if (!userInput) return res.status(400).json({ error: "No input provided" })

    if (typeof userInput !== "string") {
        return res.status(400).json({ error: "Invalid input" })
    }

    if (userInput.length > MAX_INPUT_CHARS) {
        console.warn(
            `[ask-claude] rejected oversize prompt: ${userInput.length} chars`
        )
        return res.status(413).json({ error: "Request too large" })
    }

    if (userInput.length > MAX_INPUT_CHARS * 0.8) {
        console.warn(
            `[ask-claude] prompt at ${userInput.length} chars, nearing the ` +
                `${MAX_INPUT_CHARS} cap`
        )
    }

    let response
    try {
        response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": process.env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 8192,
                messages: [{ role: "user", content: userInput }],
            }),
        })
    } catch (err) {
        console.error("[ask-claude] upstream fetch failed", err)
        await meter({ "err:claude": 1 })
        return res.status(502).json({ error: "Upstream request failed" })
    }

    let data
    try {
        data = await response.json()
    } catch {
        data = { error: { type: "bad_json", status: response.status } }
    }

    // Tokens are billed even when the answer is unusable, so count them first.
    await meter({
        ...claudeUsage(MODEL, data?.usage),
        ...(data?.stop_reason === "max_tokens" ? { "err:claude_truncated": 1 } : {}),
    })

    if (data.error) {
        // Log the upstream detail; do not hand it to the caller. An API error
        // message can carry account and configuration information.
        console.error("[ask-claude] anthropic error", data.error)
        await meter({
            "err:claude": 1,
            ...(data.error?.type === "overloaded_error" ? { "err:claude_overloaded": 1 } : {}),
        })
        return res.status(502).json({ error: "Model request failed" })
    }

    const answer = data?.content?.[0]?.text
    if (typeof answer !== "string") {
        return res.status(500).json({ error: "Empty response from model" })
    }

    // stop_reason === "max_tokens" means the answer was truncated at the cap
    res.status(200).json({ answer, stopReason: data.stop_reason })
}

export default withGuard(handler, {
    prefix: "ask-claude",
    limit: 15,
    windowSec: 60,
    // Per visitor per day (Nov 2026). A trip is 3-6 planning calls (the place,
    // 1-3 itinerary parts, the splurge list), plus the odd retry. The site
    // shows "3 trips left today"; 30 leaves room for retries, a long trip and
    // "surprise me" suggestions without ever stopping normal use, while
    // keeping one person from spending the site's whole day.
    ipDailyCap: 30,
    // The real spend ceiling. Per-IP limits do not survive IP rotation; this
    // does. A complete trip is roughly 5-15 calls, so 500/day is on the order
    // of 35-100 trips. Raise it when you have traffic data.
    dailyCap: 500,
})
