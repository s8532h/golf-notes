const { URL } = require("url");
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const clean = (s = "") => s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
async function getPage(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; GolfNotes/1.0)", accept: "text/html,*/*;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error("ページ取得に失敗しました (" + res.status + ")");
  return (await res.text()).slice(0, 2200000);
}
function safeUrl(raw, base) {
  try { const u = new URL(raw, base); return ["http:", "https:"].includes(u.protocol) ? u : null; } catch { return null; }
}
function extract(html, pageUrl) {
  const page = new URL(pageUrl), links = [], images = [], seen = new Set();
  const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || page.hostname);
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/\bhref=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const u = safeUrl(href, page.href);
    if (!u || u.hostname !== page.hostname || !/^https?:$/.test(u.protocol)) continue;
    const text = clean(m[2]);
    if (/(コース|レイアウト|ホール|course|layout|hole|east|west|東コース|西コース|OUT|IN)/i.test(text + " " + u.pathname)) {
      if (!links.some(x => x.url === u.href)) links.push({ title: text || u.pathname, url: u.href });
    }
  }
  const addImage = (src, alt) => {
    const u = safeUrl(src, page.href);
    if (!u || seen.has(u.href)) return;
    seen.add(u.href); images.push({ url: u.href, alt: clean(alt || "") });
  };
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) ) {
    const a = m[1];
    const src = (a.match(/\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i) || [])[1];
    const alt = (a.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
    const clue = src + " " + alt + " " + a;
    if (src && /(course|layout|hole|map|コース|レイアウト|ホール|yard|東|西)/i.test(clue)) addImage(src, alt);
  }
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) if (/(course|layout|hole|map|コース|レイアウト|ホール)/i.test(m[1])) addImage(m[1], "CSS背景画像");
  return { title, url: page.href, links, images };
}
exports.handler = async (event) => {
  try {
    const raw = event.queryStringParameters?.page;
    if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ error: "公式サイトURLを指定してください" }) };
    const root = new URL(raw);
    if (!["http:", "https:"].includes(root.protocol) || root.hostname === "localhost" || root.hostname.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(root.hostname)) throw new Error("このURLは確認できません");
    const rootHtml = await getPage(root.href);
    const rootData = extract(rootHtml, root.href);
    const queue = rootData.links.filter(x => /(course|layout|hole|コース|レイアウト|ホール|east|west|東|西)/i.test(x.title + " " + x.url)).slice(0, 16);
    const pages = [rootData];
    const visited = new Set([root.href]);
    for (const item of queue) {
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      try {
        const html = await getPage(item.url);
        const data = extract(html, item.url);
        // Keep discovered course pages and their images; don't crawl unrelated site sections.
        if (data.images.length || /(course|layout|hole|コース|レイアウト|ホール|east|west|東|西)/i.test(data.title + " " + item.title)) pages.push({ ...data, title: data.title || item.title });
      } catch {}
      if (pages.length >= 12) break;
    }
    const allImages = pages.flatMap(p => p.images.map(im => ({ ...im, pageTitle: p.title, pageUrl: p.url })));
    const coursePages = pages.filter(p => p.url !== root.href);
    return { statusCode: 200, headers, body: JSON.stringify({ root: root.href, rootTitle: rootData.title, pages: coursePages, images: allImages, scannedPages: pages.length }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "サイトを調査できませんでした" }) };
  }
};
