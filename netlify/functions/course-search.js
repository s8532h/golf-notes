const { URL } = require("url");
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const clean = (s = "") => s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
async function request(url, accept = "text/html,*/*;q=0.8") {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36", accept }, redirect: "follow", signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return (await res.text()).slice(0, 2200000);
}
async function getPage(url) {
  try { return { html: await request(url), via: "direct" }; }
  catch (directError) {
    // Some Japanese sites reject serverless fetches. Reader proxy provides a text fallback.
    const proxyUrl = "https://r.jina.ai/" + url;
    try { return { html: await request(proxyUrl, "text/plain,*/*;q=0.8"), via: "reader-proxy" }; }
    catch (proxyError) { throw new Error("公式サイトへの接続に失敗しました（直接取得: " + directError.message + " / 代替取得: " + proxyError.message + "）"); }
  }
}
function safeUrl(raw, base) {
  try { const u = new URL(raw, base); return ["http:", "https:"].includes(u.protocol) ? u : null; } catch { return null; }
}
function parsePage(html, pageUrl, via) {
  const page = new URL(pageUrl);
  const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || (html.match(/^Title:\s*(.+)$/mi) || [])[1] || page.hostname);
  const links = [], images = [], seen = new Set();
  const addLink = (href, label) => {
    const u = safeUrl(href, page.href);
    if (!u || u.hostname !== page.hostname) return;
    if (!/(コース|レイアウト|ホール|course|layout|hole|east|west|東|西|OUT|IN)/i.test(label + " " + u.pathname)) return;
    if (!links.some(x => x.url === u.href)) links.push({ title: clean(label) || u.pathname, url: u.href });
  };
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/\bhref=["']([^"']+)["']/i) || [])[1];
    if (href) addLink(href, m[2]);
  }
  // Jina Reader's markdown output: [link text](URL), ![alt](image URL)
  for (const m of html.matchAll(/!?\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+[^)]*)?\)/g)) {
    if (m[0].startsWith("!")) {
      const u = safeUrl(m[2], page.href);
      if (u) { if (!seen.has(u.href)) { seen.add(u.href); images.push({ url: u.href, alt: clean(m[1]) }); } }
    } else addLink(m[2], m[1]);
  }
  const addImage = (src, alt) => {
    const u = safeUrl(src, page.href);
    if (!u || seen.has(u.href)) return;
    seen.add(u.href); images.push({ url: u.href, alt: clean(alt || "") });
  };
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const a = m[1], src = (a.match(/\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i) || [])[1];
    const alt = (a.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
    if (src && /(course|layout|hole|map|コース|レイアウト|ホール|yard|東|西)/i.test(src + " " + alt + " " + a)) addImage(src, alt);
  }
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) if (/(course|layout|hole|map|コース|レイアウト|ホール)/i.test(m[1])) addImage(m[1], "CSS背景画像");
  return { title, url: page.href, links, images, via };
}
exports.handler = async (event) => {
  try {
    const raw = event.queryStringParameters?.page;
    if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ error: "公式サイトURLを指定してください" }) };
    const root = new URL(raw);
    if (!["http:", "https:"].includes(root.protocol) || root.hostname === "localhost" || root.hostname.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(root.hostname)) throw new Error("このURLは確認できません");
    const first = await getPage(root.href);
    const rootData = parsePage(first.html, root.href, first.via);
    const rootLinks = [...rootData.links];
    // For the verified Toride Kokusai site, its public course-guide path is explicit.
    if (root.hostname === "www.tkg36.com" || root.hostname === "tkg36.com") {
      rootLinks.unshift({ title: "コースガイド", url: new URL("/course.html", root).href });
    }
    const queue = rootLinks.filter(x => /(course|layout|hole|コース|レイアウト|ホール|east|west|東|西)/i.test(x.title + " " + x.url)).slice(0, 18);
    const pages = [rootData], visited = new Set([root.href]);
    for (const item of queue) {
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      try {
        const fetched = await getPage(item.url);
        const data = parsePage(fetched.html, item.url, fetched.via);
        if (data.images.length || data.links.length || /(course|layout|hole|コース|レイアウト|ホール|east|west|東|西)/i.test(data.title + " " + item.title)) pages.push(data);
        for (const child of data.links) if (!visited.has(child.url) && queue.length < 30) queue.push(child);
      } catch (e) { pages.push({ title: item.title + "（取得失敗）", url: item.url, links: [], images: [], error: e.message }); }
      if (pages.length >= 15) break;
    }
    const images = pages.flatMap(p => p.images.map(im => ({ ...im, pageTitle: p.title, pageUrl: p.url })));
    return { statusCode: 200, headers, body: JSON.stringify({ root: root.href, rootTitle: rootData.title, pages: pages.filter(p => p.url !== root.href), images, scannedPages: pages.length, sourceMode: [...new Set(pages.map(p => p.via).filter(Boolean))] }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "サイトを調査できませんでした" }) };
  }
};
