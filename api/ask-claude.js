import { withGuard } from "./_guard.js"

export const maxDuration = 60;

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end()
  const { userInput } = req.body
  if (!userInput) return res.status(400).json({ error: "No input provided" })
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: userInput }],
    }),
  })
  const data = await response.json()
  if (data.error) return res.status(500).json({ error: data.error.message })
  // Guard against an unexpected/empty response shape
  const answer = data?.content?.[0]?.text
  if (typeof answer !== "string") {
    return res.status(500).json({ error: "Empty response from model" })
  }
  // stop_reason === "max_tokens" means the answer was truncated at the cap
  res.status(200).json({ answer, stopReason: data.stop_reason })
}

export default withGuard(handler, { limit: 15, windowSec: 60, prefix: "ask-claude" })
