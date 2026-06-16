export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { userInput } = req.body;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: userInput }],
    }),
  });

  const data = await response.json();
  res.status(200).json({ answer: data.content[0].text });
}
