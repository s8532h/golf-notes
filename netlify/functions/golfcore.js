// Netlify Function: keep the GolfCore API key on the server.
const API_BASE = "https://api.golfcore.org/v1";
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const requestBuckets = new Map();

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    body: JSON.stringify(body)
  };
}

function allowRequest(ip) {
  const now = Date.now();
  const recent = (requestBuckets.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) return false;
  recent.push(now);
  requestBuckets.set(ip, recent);
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.GOLFCORE_API_KEY;
  if (!apiKey) {
    return json(503, { error: "GolfCore API is not configured on this deploy preview." });
  }

  const ip = event.headers?.["x-nf-client-connection-ip"] ||
    event.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
  if (!allowRequest(ip)) {
    return json(429, { error: "Too many requests. Please wait one minute and try again." });
  }

  const path = (event.path || "").replace(/^.*?\\/.netlify\\/functions\\/golfcore/, "");
  let upstreamUrl;

  if (path === "/courses" || path === "") {
    const query = String(event.queryStringParameters?.q || "").trim();
    if (!query || query.length > 120) {
      return json(400, { error: "A course query of 1–120 characters is required." });
    }
    upstreamUrl = new URL(API_BASE + "/courses");
    upstreamUrl.searchParams.set("q", query);
    upstreamUrl.searchParams.set("country", "jp");
    upstreamUrl.searchParams.set("limit", "10");
  } else {
    const match = path.match(/^\\/courses\\/([a-zA-Z0-9_-]{1,100})$/);
    if (!match) return json(404, { error: "Unknown GolfCore endpoint." });
    upstreamUrl = new URL(API_BASE + "/courses/" + encodeURIComponent(match[1]));
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      signal: AbortSignal.timeout(12_000)
    });
    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      },
      body
    };
  } catch (error) {
    return json(502, { error: "GolfCore could not be reached. Please try again later." });
  }
};
