const { URL } = require("url");

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function stripTags(value = "") { return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim()); }
function absoluteUrl(src, base) {
  try { const u = new URL(src, base); return ["http:", "https:"].includes(u.protocol) ? u.href : ""; }
  catch { return ""; }
}
function unwrapUrl(value) {
  try {
    const u = new URL(decodeHtml(value));
    for (const key of ["uddg", "url", "u"]) {
      const target = u.searchParams.get(key);
      if (target) { try { return decodeURIComponent(target); } catch { return target; } }
    }
    return u.href;
  } catch { return ""; }
}
function normalizeResult(title, href, snippet = "") {
  const url = unwrapUrl(href);
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || /(^|\\.)duckduckgo\\.com$|(^|\\.)bing\\.com$|(^|\\.)google\\.com$/.test(u.hostname)) return null;
    return { title: stripTags(title), url: u.href, domain: u.hostname.replace(/^www\\./, ""), snippet: stripTags(snippet) };
  } catch { return null; }
}
function parseDuckDuckGo(html) {
  const out = [];
  // Attribute order varies, so match the class and href independently.
  for (const m of html.matchAll(/<a\\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\\s\\S]*?)<\\/a>/gi)) {
    const href = (m[1].match(/\\bhref=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 1800);
    const sm = after.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>/i);
    const item = normalizeResult(m[2], href, sm?.[1] || "");
    if (item) out.push(item);
  }
  return out;
}
function parseBingRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\\s\\S]*?)<\\/item>/gi)) {
    const block = m[1];
    const title = (block.match(/<title>([\\s\\S]*?)<\\/title>/i) || [])[1] || "";
    const link = (block.match(/<link>([\\s\\S]*?)<\\/link>/i) || [])[1] || "";
    const desc = (block.match(/<description>([\\s\\S]*?)<\\/description>/i) || [])[1] || "";
    const item = normalizeResult(title, link, desc);
    if (item) out.push(item);
  }
  return out;
}
function scoreResult(item, query) {
  const text = (item.title + " " + item.domain + " " + item.snippet).toLowerCase();
  let score = 0;
  if (/公式|official/.test(text)) score += 8;
  if (/ゴルフ倶楽部|ゴルフクラブ|ゴルフ場|golf club|golf course/.test(text)) score += 5;
  if (/コースガイド|コース案内|course guide|layout|レイアウト/.test(text)) score += 6;
  if (/予約|booking|gdo|楽天|じゃらん/.test(text)) score -= 2;
  const terms = query.toLowerCase().replace(/ゴルフ倶楽部|ゴルフクラブ|ゴルフ場/g, "").trim().split(/[\\s　]+/).filter(x => x.length > 1);
  for (const term of terms) if (text.includes(term)) score += 3;
  return score;
}
async function fetchText(url, maxBytes = 1800000) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; GolfNotes/1.0)", "accept": "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8" },
    redirect: "follow", signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("検索サービスに接続できませんでした (" + response.status + ")");
  const text = await response.text();
  return text.slice(0, maxBytes);
}

exports.handler = async (event) => {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  try {
    if (event.queryStringParameters?.q) {
      const q = String(event.queryStringParameters.q).slice(0, 120).trim();
      const queries = [
        q + " ゴルフ場 公式 コースガイド",
        q + " ゴルフ倶楽部 公式サイト コースレイアウト",
        q + " golf course official course guide"
      ];
      const searches = await Promise.allSettled(queries.map(async (term) => {
        const url = "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(term);
        return parseBingRss(await fetchText(url, 700000));
      }));
      let results = searches.flatMap(x => x.status === "fulfilled" ? x.value : []);
      // DDG is a fallback, not the sole search provider.
      if (results.length < 3) {
        const fallback = await Promise.allSettled(queries.slice(0, 2).map(async term =>
          parseDuckDuckGo(await fetchText("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(term), 1200000))
        ));
        results.push(...fallback.flatMap(x => x.status === "fulfilled" ? x.value : []));
      }
      const deduped = new Map();
      for (const item of results) {
        const key = new URL(item.url).hostname + new URL(item.url).pathname;
        const prev = deduped.get(key);
        if (!prev || scoreResult(item, q) > scoreResult(prev, q)) deduped.set(key, item);
      }
      results = [...deduped.values()].sort((a, b) => scoreResult(b, q) - scoreResult(a, q)).slice(0, 10);
      return { statusCode: 200, headers, body: JSON.stringify({ results, providers: ["Bing RSS", "DuckDuckGo fallback"] }) };
    }

    const page = event.queryStringParameters?.page;
    if (page) {
      const u = new URL(page);
      if (!["http:", "https:"].includes(u.protocol) || u.hostname === "localhost" || u.hostname.endsWith(".local") || /^\\d{1,3}(\\.\\d{1,3}){3}$/.test(u.hostname)) throw new Error("このURLは確認できません");
      const html = await fetchText(u.href, 2200000);
      const images = [], seen = new Set();
      const addImage = (src, alt) => {
        const imageUrl = absoluteUrl(src, u.href);
        if (!imageUrl || seen.has(imageUrl)) return;
        const host = new URL(imageUrl).hostname;
        if (host !== u.hostname && !host.endsWith("." + u.hostname)) return;
        seen.add(imageUrl); images.push({ url: imageUrl, alt: stripTags(alt || "") });
      };
      for (const m of html.matchAll(/<img\\b([^>]+)>/gi)) {
        const attrs = m[1];
        const src = (attrs.match(/\\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i) || [])[1];
        const alt = (attrs.match(/\\balt=["']([^"']*)["']/i) || [])[1] || "";
        const candidate = (src + " " + alt + " " + attrs).toLowerCase();
        if (src && /(course|layout|hole|map|コース|レイアウト|ホール|ヤーデージ|東コース|西コース)/i.test(candidate)) addImage(src, alt);
      }
      for (const m of html.matchAll(/<meta\\b([^>]+)>/gi)) {
        const attrs = m[1];
        const property = (attrs.match(/\\b(?:property|name)=["']([^"']+)["']/i) || [])[1] || "";
        const content = (attrs.match(/\\bcontent=["']([^"']+)["']/i) || [])[1] || "";
        if (/og:image|twitter:image/i.test(property) && /(course|layout|hole|map|コース|レイアウト|ホール)/i.test(content)) addImage(content, "ページのコース画像候補");
      }
      return { statusCode: 200, headers, body: JSON.stringify({ page: u.href, images: images.slice(0, 20) }) };
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: "q または page を指定してください" }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "検索エラー" }) };
  }
};
