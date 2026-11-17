const { URL } = require("url");
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const clean = (s = "") => s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
async function request(url, accept = "text/html,*/*;q=0.8") {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36", accept }, redirect: "follow", signal: AbortSignal.timeout(1800) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return (await res.text()).slice(0, 2200000);
}
async function getPage(url) {
  try { return { html: await request(url), via: "direct" }; }
  catch (a) {
    try { return { html: await request("https://r.jina.ai/" + url, "text/plain,*/*;q=0.8"), via: "reader-proxy" }; }
    catch (b) { throw new Error("直接取得: " + a.message + " / 代替取得: " + b.message); }
  }
}
function safeUrl(raw, base) { try { const u = new URL(raw, base); return ["http:", "https:"].includes(u.protocol) ? u : null; } catch { return null; } }
function extractImages(html, pageUrl) {
  const images = [], seen = new Set(), add = (src, alt) => { const u = safeUrl(src, pageUrl); if (u && !seen.has(u.href)) { seen.add(u.href); images.push({ url: u.href, alt: clean(alt || "") }); } };
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const a = m[1], src = (a.match(/\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i) || [])[1], alt = (a.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
    if (src) add(src, alt);
  }
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) if (/(course|layout|hole|map|コース|レイアウト|ホール)/i.test(m[1])) add(m[1], "コース画像候補");
  return images;
}
function parseHoleData(html, pageUrl, courseName) {
  const rows = [];
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => clean(x[1]));
    if (cells.length < 5) continue;
    const hole = Number(cells[0]), hdcp = Number(cells[1]), par = Number(cells[2]);
    if (!Number.isInteger(hole) || hole < 1 || hole > 18 || !Number.isFinite(hdcp) || !Number.isFinite(par)) continue;
    const distances = cells.slice(3).map(x => Number((x.match(/\d{2,4}/) || [])[0])).filter(Number.isFinite);
    if (!distances.length) continue;
    // Generic fallback: do not infer tee labels from a course-specific URL.
    rows.push({ hole, par, strokeIndex: hdcp, yards: distances[0], tee: "掲載順1番目" });
  }
  // Reader-proxy fallback often returns Markdown tables instead of HTML.
  for (const line of html.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells=line.split("|").map(x=>clean(x));
    const hole=Number(cells[1]||cells[0]),hdcp=Number(cells[2]||cells[1]),par=Number(cells[3]||cells[2]);
    if (!Number.isInteger(hole)||hole<1||hole>18||!Number.isFinite(hdcp)||!Number.isFinite(par)) continue;
    const nums=cells.slice(cells[1]&&/^\d+$/.test(cells[1])?4:3).map(x=>Number((x.match(/\d{2,4}/)||[])[0])).filter(Number.isFinite);
    if(!nums.length)continue;
    const yards=nums[0];
    if(!rows.some(x=>x.hole===hole))rows.push({hole,par,strokeIndex:hdcp,yards,tee:"掲載順1番目"});
  }
  const details = new Map();
  const headingRe = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const headings = [...html.matchAll(headingRe)];
  for (let i=0;i<headings.length;i++) {
    const label = clean(headings[i][2]), hm = label.match(/HOLE\s*(\d+)/i);
    if (!hm) continue;
    const hole = Number(hm[1]), end = headings[i+1]?.index ?? html.length;
    const block = html.slice(headings[i].index, end);
    const text = clean(block);
    const desc = text.replace(/^.*?HOLE\s*\d+/i, "").replace(/PAR\s*:\s*\d+.*?HDCP\s*:\s*\d+/i, "").slice(0, 900);
    const imgs = extractImages(block, pageUrl);
    details.set(hole, { description: desc, imageUrl: imgs[0]?.url || "" });
  }
  const mdHeads=[...html.matchAll(/^#{2,6}\s*HOLE\s*(\d+)\s*$/gim)];
  for(let i=0;i<mdHeads.length;i++){
    const hole=Number(mdHeads[i][1]),start=mdHeads[i].index+mdHeads[i][0].length,end=mdHeads[i+1]?.index??html.length;
    const block=html.slice(start,end);
    const desc=block.split(/\r?\n/).map(x=>x.replace(/^\s*[-*]\s*/,"").trim()).filter(x=>x&&!x.startsWith("|")&&!/^PAR\s*:|^HDCP\s*:/i.test(x)&&!/^!\[/.test(x)).join(" ").slice(0,900);
    const im=(block.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)/)||[])[1]||"";
    if(!details.has(hole))details.set(hole,{description:desc,imageUrl:im});
  }
  // Generic detail-page parser: common Japanese course pages expose
  // "East No.1 / PAR / HDCP / A GREEN / B GREEN" as labeled content, not a table.
  const pageText=clean(html);
  const titleMatch=(courseName+" "+pageUrl).match(/\b(East|West)\s*No\.?\s*(\d{1,2})\b/i)||pageText.match(/\b(East|West)\s*No\.?\s*(\d{1,2})\b/i);
  if(titleMatch){
    const hole=Number(titleMatch[2]);
    const parMatch=pageText.match(/\bPAR\s*:?\s*(\d{1,2})\b/i);
    const hdcpMatch=pageText.match(/\bHDCP\s*:?\s*(\d{1,2})\b/i);
    const green=(name)=>{const re=new RegExp(name+"\\\\s*GREEN[\\\\s\\\\S]{0,160}?REGULAR\\\\s*:?\\\\s*(\\\\d{2,4})","i");return Number((pageText.match(re)||[])[1])||null;};
    const a=green("A"),b=green("B");
    if(hole>=1&&hole<=18&&parMatch&&(a||b)&&!rows.some(x=>x.hole===hole)){
      const featureMatch=pageText.match(/特徴\\s*([\\s\\S]{0,700}?)(?:PAR\\s*:?\\s*\\d|HDCP\\s*:?\\s*\\d)/i);
      const imgs=extractImages(html,pageUrl);
      rows.push({hole,par:Number(parMatch[1]),strokeIndex:hdcpMatch?Number(hdcpMatch[1]):null,yards:a||b,tee:a?"REG（Aグリーン）":"REG（Bグリーン）",description:featureMatch?featureMatch[1].trim():"",imageUrl:imgs[0]?.url||"",greenDistances:{A:a,B:b},course:titleMatch[1].toLowerCase()==="east"?"東コース":"西コース"});
    }
  }
  return rows.map(r => ({ ...r, ...details.get(r.hole), course: courseName, sourceUrl: pageUrl }));
}
function parsePage(html, pageUrl, via) {
  const page = new URL(pageUrl), title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || page.hostname);
  const links = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/\bhref=["']([^"']+)["']/i) || [])[1]; if (!href) continue;
    const u = safeUrl(href, page.href); if (!u || u.hostname !== page.hostname) continue;
    const label = clean(m[2]);
    if (/(コース|レイアウト|ホール|course|layout|hole|east|west|東|西)/i.test(label + " " + u.pathname) && !links.some(x=>x.url===u.href)) links.push({ title: label || u.pathname, url: u.href });
  }
  return { title, url: page.href, links, images: extractImages(html, page.href), holes: parseHoleData(html,page.href,title), via };
}
exports.handler = async (event) => {
  try {
    const raw = event.queryStringParameters?.page;
    if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ error: "公式サイトURLを指定してください" }) };
    const root = new URL(raw);
    if (!["http:", "https:"].includes(root.protocol) || root.hostname === "localhost" || root.hostname.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(root.hostname)) throw new Error("このURLは確認できません");
    const first = await getPage(root.href), rootData = parsePage(first.html, root.href, first.via);
    const rootHost=root.hostname.replace(/^www\./,"");
    const sameHostLinks=(links)=>links.filter(x=>{const u=safeUrl(x.url,root.href);return u&&u.hostname.replace(/^www\./,"")===rootHost;});
    const seen=new Set([root.href]), rawPages=[];
    // Fetch first-level course pages concurrently. A single slow page must not block the others.
    const firstLinks=sameHostLinks(rootData.links).slice(0,18);
    const fetchBatch=async(items)=>Promise.all(items.map(async item=>{
      if(seen.has(item.url))return null;seen.add(item.url);
      try{
        const html=await request(item.url);
        return parsePage(html,item.url,"direct");
      }catch(e){return {title:item.title,url:item.url,links:[],images:[],holes:[],error:e.message};}
    }));
    const levelOne=(await fetchBatch(firstLinks)).filter(Boolean);
    rawPages.push(...levelOne);
    // Discover likely hole detail links one level deeper, still bounded and concurrent.
    const secondLinks=sameHostLinks(levelOne.flatMap(p=>p.links||[]))
      .filter(x=>/(hole|no[._-]?\d+|ホール|東|西|east|west)/i.test(x.title+" "+x.url))
      .filter(x=>!seen.has(x.url)).slice(0,24);
    const levelTwo=(await fetchBatch(secondLinks)).filter(Boolean);
    rawPages.push(...levelTwo);
    const pages=[];
    // Aggregate single-hole detail pages into course buckets using semantic page labels.
    const grouped=new Map();
    for(const p of rawPages){
      for(const h of (p.holes||[])){
        const label=(p.title+" "+p.url+" "+(h.course||""));
        const match=label.match(/(東|西|East|West)/i);
        const key=match?(match[1].toLowerCase()==="east"||match[1]==="東"?"東コース":"西コース"):"コース情報";
        if(!grouped.has(key))grouped.set(key,{title:key,url:p.url,links:[],images:[],holes:[],via:p.via});
        const g=grouped.get(key);
        if(!g.holes.some(x=>Number(x.hole)===Number(h.hole)))g.holes.push(h);
        g.images.push(...(p.images||[]));
      }
    }
    for(const g of grouped.values()){g.holes.sort((a,b)=>a.hole-b.hole);pages.push(g);}
    for(const p of rawPages)if((p.holes||[]).length>=9&&!pages.some(g=>g.url===p.url))pages.push(p);
    const allImages = rawPages.flatMap(p => p.images.map(im => ({ ...im, pageTitle: p.title, pageUrl: p.url })));
    return { statusCode: 200, headers, body: JSON.stringify({ root: root.href, rootTitle: rootData.title, pages, images: allImages, scannedPages: rawPages.length + 1, sourceMode: [...new Set([first.via,...pages.map(p=>p.via).filter(Boolean)])] }) };
  } catch (e) { return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "サイトを調査できませんでした" }) }; }
};
