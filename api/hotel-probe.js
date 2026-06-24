// api/hotel-probe.js  (temporary diagnostic — delete once we find the endpoint)
export const maxDuration = 30
const T = process.env.TRAVELPAYOUTS_TOKEN

async function probe(url) {
    try {
        const r = await fetch(url)
        const t = await r.text()
        let j = null
        try {
            j = JSON.parse(t)
        } catch {}
        return {
            url,
            status: r.status,
            isJson: !!j,
            len: Array.isArray(j) ? j.length : j ? Object.keys(j).length : null,
            snippet: j ? undefined : t.slice(0, 80),
        }
    } catch (e) {
        return { url, status: 0, snippet: String(e.message) }
    }
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    const ci = "2026-09-15"
    const co = "2026-09-18"
    const candidates = [
        `https://engine.hotellook.com/api/v2/cache.json?location=Rome&checkIn=${ci}&checkOut=${co}&currency=usd&limit=5&token=${T}`,
        `https://engine.hotellook.com/api/v2/lookup.json?query=Rome&lang=en&lookFor=city&limit=3&token=${T}`,
        `https://engine.hotellook.com/api/v2/cache.json?location=Rome&checkIn=${ci}&checkOut=${co}&currency=usd&limit=5`,
        `https://yasen.hotellook.com/tp/v1/hotels/cache?location=Rome&checkIn=${ci}&checkOut=${co}&currency=usd&token=${T}`,
        `https://api.travelpayouts.com/hotels/v2/cache.json?location=Rome&checkIn=${ci}&checkOut=${co}&currency=usd&token=${T}`,
    ]
    const results = []
    for (const u of candidates) results.push(await probe(u))
    res.status(200).json({ results })
}
