async function routeInfo(depCodes, arrCodes, depMonth, retMonth) {
    if (!depCodes || !arrCodes || !depMonth)
        return { found: false, reason: "missing codes" }
    const params = new URLSearchParams({
        engine: "google_flights",
        departure_id: depCodes,
        arrival_id: arrCodes,
        outbound_date: `${depMonth}-15`,
        ...(retMonth ? { return_date: `${retMonth}-18` } : {}),
        currency: "USD",
        type: retMonth ? "1" : "2",
        hl: "en",
        api_key: SERPAPI_KEY,
    })
    const g = await safeGet(`https://serpapi.com/search.json?${params}`)
    if (g.json?.error) return { found: false, error: g.json.error }
    const best = Array.isArray(g.json?.best_flights) ? g.json.best_flights : []
    const other = Array.isArray(g.json?.other_flights) ? g.json.other_flights : []
    // Price ONLY from Google's curated "best" itineraries when available. The
    // "other" bucket occasionally holds anomalous/partial fares that surface as
    // impossibly-low prices (e.g. a $222 round-trip to Hawaii).
    const pricePool = (best.length ? best : other).filter(
        (f) => typeof f.price === "number" && f.price > 0
    )
    if (!pricePool.length) return { found: false, status: g.status }
    const cheapest = [...pricePool].sort((a, b) => a.price - b.price)[0]
    // "Fastest" can still consider every itinerary.
    const allFlights = [...best, ...other]
    const durations = allFlights
        .map((f) => f.total_duration)
        .filter((n) => typeof n === "number" && n > 0)
    const fastestMin = durations.length ? Math.min(...durations) : null
    const stopsOf = (f) => (Array.isArray(f.flights) ? f.flights.length - 1 : null)
    return {
        found: true,
        cheapestPrice: Math.round(cheapest.price),
        cheapestStops: stopsOf(cheapest),
        cheapestHours:
            typeof cheapest.total_duration === "number"
                ? +(cheapest.total_duration / 60).toFixed(1)
                : null,
        fastestHours: fastestMin != null ? +(fastestMin / 60).toFixed(1) : null,
    }
}
