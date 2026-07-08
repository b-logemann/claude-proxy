import { withGuard } from "./_guard.js"

export const maxDuration = 10;

async function handler(req, res) {
  const { query } = req.query
  if (!query) return res.status(400).json({ error: "Missing query" })
  try {
    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&content_filter=high`,
      {
        headers: {
          Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
        },
      }
    )
    const data = await response.json()
    if (!response.ok) {
      return res.status(500).json({ error: "Unsplash API error" })
    }
    const photo = data.results?.[0]
    if (!photo) {
      return res.status(404).json({ error: "No photo found" })
    }
    res.status(200).json({
      url: photo.urls.regular,
      thumb: photo.urls.small,
      alt: photo.alt_description || query,
      credit: photo.user.name,
      creditUrl: photo.user.links.html,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

export default withGuard(handler, { prefix: "unsplash" })
