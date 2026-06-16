export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    return res.status(200).json({ debug: "API key is missing or undefined" });
  }

  return res.status(200).json({ debug: `API key starts with: ${apiKey.substring(0, 8)}...` });
}
