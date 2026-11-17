const { URL } = require("url");

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const decode = (s = "") => s
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const clean = (s = "") => decode(s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());

async function get(url, accept = "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8") {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122 Safari/537.36", accept },
    redirect: "follow", signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error("検索先が HTTP " + res.status + " を返しました");
  return (await res.text()).slice(0, 1800000);
}
function makeResult(title, href, snippet = "") {
  try {
    let raw = decode(href);
    if (raw.startsWith("//")) raw = "https:" + raw;
    let u = new URL(raw);
    for (const key of ["uddg", "url", "u"]) {
      const v = u.searchParams.get(key);
      if (v) { try { u = new URL(decodeURIComponent(v)); } catch { u = new URL(v); } break; }
    }
    if (!["http:", "https:"].includes(u.protocol) || /(duckduckgo|bing|google)\.com$/i.test(u.hostname)) return null;
    return { title: clean(title), url: u.href, domain: u.hostname.replace(/^www\./, ""), snippet: clean(snippet) };
  } catch { return null; }
}
function parseBing(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    const title = (b.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const link = (b.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "";
    const desc = (b.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "";
    const x = makeResult(title, link, desc); if (x) out.push(x);
  }
  return out;
}
function parseDDG(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/\bhref=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 1800);
    const snippet = (tail.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i) || [])[1] || "";
    const x = makeResult(m[2], href, snippet); if (x) out.push(x);
  }
  return out;
}
function rank(x, q) {
  const s = (x.title + " " + x.domain + " " + x.snippet).toLowerCase();
  const terms = q.toLowerCase().replace(/ゴルフ倶楽部|ゴルフクラブ|ゴルフ場/g, "").split(/[\s　]+/).filter(t => t.length > 1);
  let n = terms.reduce((a, t) => a + (s.includes(t) ? 5 : 0), 0);
  if (/公式|official/.test(s)) n += 7;
  if (/ゴルフ倶楽部|ゴルフクラブ|ゴルフ場|golf club/.test(s)) n += 4;
  if (/コースガイド|コース案内|コースレイアウト|course guide|layout/.test(s)) n += 6;
  if (/予約|booking|gdo|楽天|じゃらん/.test(s)) n -= 2;
  return n;
}

exports.handler = async (event) => {
  try {
    const p = event.queryStringParameters || {};
    if (p.q) {
      const q = String(p.q).trim().slice(0, 100);
      if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: "ゴルフ場名を入力してください" }) };
      const queries = [
        q + " ゴルフ場 公式サイト コースガイド",
        q + " ゴルフ倶楽部 コースレイアウト 東コース 西コース",
        '"' + q + '" golf course official layout'
      ];
      const attempts = await Promise.allSettled(queries.map(async term =>
        parseBing(await get("https://www.bing.com/search?format=rss&q=" + encodeURIComponent(term)))
      ));
      let found = attempts.flatMap(x => x.status === "fulfilled" ? x.value : []);
      // DuckDuckGo HTML is queried as an independent fallback and supplement.
      if (found.length < 5) {
        const fallbacks = await Promise.allSettled(queries.slice(0, 2).map(async term =>
          parseDDG(await get("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(term)))
        ));
        found.push(...fallbacks.flatMap(x => x.status === "fulfilled" ? x.value : []));
      }
      const unique = new Map();
      for (const x of found) {
        const u = new URL(x.url), key = u.hostname + u.pathname.replace(/\/$/, "");
        if (!unique.has(key) || rank(x, q) > rank(unique.get(key), q)) unique.set(key, x);
      }
      const results = [...unique.values()].sort((a, b) => rank(b, q) - rank(a, q)).slice(0, 12);
      return { statusCode: 200, headers, body: JSON.stringify({
        results, diagnostics: { bingResponses: attempts.filter(x => x.status === "fulfilled").length, bingItems: attempts.flatMap(x => x.status === "fulfilled" ? x.value : []).length, resultCount: results.length }
      }) };
    }

    if (p.page) {
      const page = new URL(String(p.page));
      if (!["http:", "https:"].includes(page.protocol) || page.hostname === "localhost" || page.hostname.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(page.hostname)) throw new Error("このURLは確認できません");
      const html = await get(page.href);
      const images = [], seen = new Set();
      const add = (src, alt) => {
        try {
          const u = new URL(decode(src), page.href);
          if (!["http:", "https:"].includes(u.protocol) || seen.has(u.href)) return;
          seen.add(u.href); images.push({ url: u.href, alt: clean(alt) });
        } catch {}
      };
      for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
        const a = m[1];
        const src = (a.match(/\b(?:src|data-src|data-original|data-lazy-src|srcset)=["']([^"']+)["']/i) || [])[1];
        const alt = (a.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
        if (src && /(course|layout|hole|map|コース|レイアウト|ホール|ヤーデージ|東コース|西コース)/i.test(src + " " + alt)) add(src.split(",")[0].trim().split(/\s+/)[0], alt);
      }
      // CSS background images are common for Japanese golf-course sites.
      for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
        const src = m[1];
        if (/(course|layout|hole|map|コース|レイアウト|ホール|yard)/i.test(src)) add(src, "CSS背景画像候補");
      }
      return { statusCode: 200, headers, body: JSON.stringify({ page: page.href, images: images.slice(0, 30) }) };
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: "q または page を指定してください" }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "検索エラー" }) };
  }
};
