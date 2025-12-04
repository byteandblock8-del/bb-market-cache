// api/market-overview.js

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Simple in-memory cache (per Vercel function instance)
let cache = {
  ts: 0,
  data: null,
};

async function fetchFromCoinGecko() {
  const [marketsRes, trendingRes, globalRes] = await Promise.all([
    fetch(
      "https://api.coingecko.com/api/v3/coins/markets" +
        "?vs_currency=usd&order=market_cap_desc&per_page=100&page=1" +
        "&sparkline=false&price_change_percentage=24h,7d,30d"
    ),
    fetch("https://api.coingecko.com/api/v3/search/trending"),
    fetch("https://api.coingecko.com/api/v3/global"),
  ]);

  if (!marketsRes.ok) throw new Error("markets request failed");
  if (!trendingRes.ok) throw new Error("trending request failed");
  if (!globalRes.ok) throw new Error("global request failed");

  const markets = await marketsRes.json();
  const trendingJson = await trendingRes.json();
  const global = await globalRes.json();

  const trending = (trendingJson.coins || []).map((c) => ({ id: c.item.id }));

  return {
    markets,
    trending,
    global,
  };
}

export default async function handler(req, res) {
  // --- CORS so your blog can call this from any domain ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // preflight
  }

  const now = Date.now();

  // If cache is still fresh, return it
  if (cache.data && now - cache.ts < CACHE_TTL_MS) {
    return res.status(200).json({
      ...cache.data,
      source: "cache",
    });
  }

  try {
    const data = await fetchFromCoinGecko();

    cache = {
      ts: now,
      data,
    };

    return res.status(200).json({
      ...data,
      source: "live",
    });
  } catch (err) {
    console.error("CoinGecko fetch failed:", err);

    if (cache.data) {
      // fall back to stale cache
      return res.status(200).json({
        ...cache.data,
        source: "stale-cache",
      });
    }

    return res.status(500).json({ error: "Failed to load market data" });
  }
}
