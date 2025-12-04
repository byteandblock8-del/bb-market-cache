// api/coin-tickers.js

const CG_BASE = "https://api.coingecko.com/api/v3";

export default async function handler(req, res) {
  const coin = req.query.coin || "bitcoin";

  const cgUrl =
    `${CG_BASE}/coins/${encodeURIComponent(coin)}` +
    "/tickers?include_exchange_logo=false";

  try {
    const cgRes = await fetch(cgUrl);

    if (!cgRes.ok) {
      res.status(502).json({ error: "CoinGecko error", status: cgRes.status });
      return;
    }

    const json = await cgRes.json();

    const tickers = (json.tickers || [])
      .filter(
        (t) =>
          t.target &&
          t.target.toUpperCase().includes("USD") &&
          t.converted_last &&
          typeof t.converted_last.usd === "number"
      )
      .map((t) => ({
        exchange: t.market?.name || "Unknown",
        pair: `${(t.base || "").toUpperCase()}/${(t.target || "").toUpperCase()}`,
        price: t.converted_last.usd,
        volume: t.converted_volume?.usd || 0,
      }))
      .sort((a, b) => (b.volume || 0) - (a.volume || 0))
      .slice(0, 6);

    // Cache at Vercel edge (shared across users)
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.status(200).json({
      coin,
      tickers,
      source: "live-or-cache",
    });
  } catch (err) {
    console.error("coin-tickers error:", err);

    res.status(500).json({
      error: "Failed to fetch CoinGecko",
    });
  }
}
