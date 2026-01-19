// api/market-overview.js

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Simple in-memory cache (per Vercel function instance)
let cache = {
  ts: 0,
  data: null,
};

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function median(values) {
  const arr = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
}

function computeTop3Snapshot(markets) {
  const ids = ["bitcoin", "ethereum", "solana"];
  const byId = new Map((markets || []).map((c) => [c.id, c]));

  return ids
    .map((id) => {
      const c = byId.get(id);
      if (!c) return null;

      return {
        id: c.id,
        name: c.name,
        symbol: c.symbol,
        priceUsd: safeNumber(c.current_price),
        change24hPct: safeNumber(c.price_change_percentage_24h_in_currency),
        change30dPct: safeNumber(c.price_change_percentage_30d_in_currency),
        marketCapUsd: safeNumber(c.market_cap),
      };
    })
    .filter(Boolean);
}

/**
 * NOTE:
 * This mood is intentionally "lightweight" so we don't add 100x historical calls.
 * It’s still useful (breadth + leadership + global change), and you can extend it later
 * with MA/ATR using a separate cached endpoint if you want.
 */
function computeMood(markets, globalJson) {
  const arr = markets || [];
  if (!arr.length) {
    return {
      state: "unknown",
      label: "Unknown",
      score: null,
      metrics: {},
    };
  }

  // Breadth proxies (since we aren't computing MA breadth here yet)
  const up24h = arr.filter((c) => (c.price_change_percentage_24h_in_currency ?? -999) > 0).length;
  const up7d = arr.filter((c) => (c.price_change_percentage_7d_in_currency ?? -999) > 0).length;

  const pctUp24h = up24h / arr.length;
  const pctUp7d = up7d / arr.length;

  // Leadership proxy: BTC 30d vs median alt 30d
  const btc = arr.find((c) => c.id === "bitcoin");
  const btc30d = safeNumber(btc?.price_change_percentage_30d_in_currency);

  const alt30dValues = arr
    .filter((c) => c.id !== "bitcoin")
    .map((c) => c.price_change_percentage_30d_in_currency);

  const medianAlt30d = median(alt30dValues);
  const leadershipGap30d =
    btc30d !== null && medianAlt30d !== null ? btc30d - medianAlt30d : null;

  // Global market-cap 24h change (CoinGecko global endpoint)
  // CoinGecko returns: { data: { market_cap_change_percentage_24h_usd: ... } }
  const mcapChange24h =
    safeNumber(globalJson?.data?.market_cap_change_percentage_24h_usd) ??
    safeNumber(globalJson?.market_cap_change_percentage_24h_usd); // defensive

  // Score (0..100): simple blend so it behaves consistently day-to-day
  // - Breadth matters most
  // - Leadership gap penalizes "BTC up, alts dead"
  // - Market cap change nudges the score
  let score = 50;

  score += (pctUp24h - 0.5) * 40; // +/-20
  score += (pctUp7d - 0.5) * 40; // +/-20

  if (leadershipGap30d !== null) {
    // If BTC is outperforming alts by a lot, it's often a "risk-off / narrow market" vibe
    score -= Math.max(0, leadershipGap30d) * 0.5; // mild penalty
  }

  if (mcapChange24h !== null) {
    score += mcapChange24h * 1.5; // small nudge
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  // Map score → themed state label (you can swap names later)
  let state = "uneasy";
  let label = "Uneasy";

  if (score >= 75) {
    state = "snack-mode";
    label = "Snack Mode";
  } else if (score >= 60) {
    state = "steady-bite";
    label = "Steady Bite";
  } else if (score >= 45) {
    state = "side-eye";
    label = "Side-Eye";
  } else if (score >= 30) {
    state = "clutching-cookies";
    label = "Clutching Cookies";
  } else {
    state = "crumbs-everywhere";
    label = "Crumbs Everywhere";
  }

  return {
    state,
    label,
    score,
    metrics: {
      pctUp24h: Number(pctUp24h.toFixed(2)),
      pctUp7d: Number(pctUp7d.toFixed(2)),
      btc30d,
      medianAlt30d,
      leadershipGap30d,
      marketCapChange24hPct: mcapChange24h,
    },
  };
}

function computeAdjacentStates(state) {
  const states = [
    "crumbs-everywhere",
    "clutching-cookies",
    "side-eye",
    "steady-bite",
    "snack-mode",
  ];

  const i = states.indexOf(state);
  if (i === -1) return { prev: null, next: null };

  return {
    prev: states[i - 1] ?? null,
    next: states[i + 1] ?? null,
  };
}

function buildCoinsRowFromTop3(top3Snapshot) {
  return (top3Snapshot || []).map((c) => ({
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    name: c.name,
    priceUsd: c.priceUsd,
    chg24h: c.change24hPct,
    chg30d: c.change30dPct,
  }));
}

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

  // Converter prices (top 50 IDs)
  const top50Ids = markets.slice(0, 50).map((c) => c.id).join(",");
  const simpleRes = await fetch(
    "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=" +
      encodeURIComponent(top50Ids) +
      "&vs_currencies=usd,eur,gbp"
  );
  if (!simpleRes.ok) throw new Error("simple price request failed");
  const converterPrices = await simpleRes.json();

  // Additive-only fields (won't break existing consumers)
  const top3Snapshot = computeTop3Snapshot(markets);
  const baseMood = computeMood(markets, global);

  // NEW: adjacent states + ghostKey (static image mapping happens in WP)
  const adjacent = computeAdjacentStates(baseMood.state);

  const mood = {
    ...baseMood,
    adjacent,                // { prev, next }
    ghostKey: baseMood.state // e.g. "crumbs-everywhere"
  };

  // NEW: compact coin row (BTC/ETH/SOL) with 24h + 30d
  const coins = buildCoinsRowFromTop3(top3Snapshot);

  return {
    markets,
    trending,
    global,

    // existing field
    converterPrices,

    // new fields (safe to add)
    mood,
    top3Snapshot,
    coins, // ✅ ADD THIS
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
