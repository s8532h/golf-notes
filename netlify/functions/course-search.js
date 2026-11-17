const { URL } = require("url");
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const clean = (s = "") => s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
async function request(url, accept = "text/html,*/*;q=0.8") {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36", accept }, redirect: "follow", signal: AbortSignal.timeout(12000) });
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
    // East has one green. West lists Korai then Bent; REG is the second distance in either group.
    const isWest = /west/i.test(new URL(pageUrl).pathname);
    const regDistance = isWest ? (distances[5] || distances[1]) : (distances[1] || distances[0]);
    rows.push({ hole, par, strokeIndex: hdcp, yards: regDistance, tee: isWest ? "REG（BENT）" : "REG" });
  }
  // Reader-proxy fallback often returns Markdown tables instead of HTML.
  for (const line of html.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells=line.split("|").map(x=>clean(x));
    const hole=Number(cells[1]||cells[0]),hdcp=Number(cells[2]||cells[1]),par=Number(cells[3]||cells[2]);
    if (!Number.isInteger(hole)||hole<1||hole>18||!Number.isFinite(hdcp)||!Number.isFinite(par)) continue;
    const nums=cells.slice(cells[1]&&/^\d+$/.test(cells[1])?4:3).map(x=>Number((x.match(/\d{2,4}/)||[])[0])).filter(Number.isFinite);
    if(!nums.length)continue;
    const isWest=/west/i.test(new URL(pageUrl).pathname),yards=isWest?(nums[5]||nums[1]):(nums[1]||nums[0]);
    if(!rows.some(x=>x.hole===hole))rows.push({hole,par,strokeIndex:hdcp,yards,tee:isWest?"REG（BENT）":"REG"});
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
  return rows.map(r => ({ ...r, ...details.get(r.hole), course: courseName, sourceUrl: pageUrl }));
}
function parseTokyuHoles(html,pageUrl,courseName){
 const rows=[],isWest=/course_w|west/i.test(pageUrl);
 const headingRe=/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi,heads=[...html.matchAll(headingRe)];
 for(let i=0;i<heads.length;i++){
  const label=clean(heads[i][2]),hm=label.match(/(?:OUT|IN\s*)?(\d{1,2})\s*Hole\s*Par\s*(\d)/i);
  if(!hm)continue;
  const hole=Number(hm[1]),par=Number(hm[2]),end=heads[i+1]?.index??html.length,block=html.slice(heads[i].index,end);
  const distanceRows=[...block.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>[...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>clean(x[1])));
  let reg=null,old=null;
  for(const cells of distanceRows){
   if(!/^(OLD|NEW)$/i.test(cells[0]||""))continue;
   const ds=cells.slice(1).map(x=>Number((x.match(/\d{2,4}/)||[])[0])).filter(Number.isFinite);
   if(ds.length>=2){if(/^NEW$/i.test(cells[0]))reg=ds[1];else old=ds[1];}
  }
  if(!reg&&old)reg=old;
  if(!reg)continue;
  const text=clean(block).replace(/.*?Hole\s*Par\s*\d/i,"").slice(0,900);
  const imgs=extractImages(block,pageUrl);
  rows.push({hole,par,strokeIndex:null,yards:reg,tee:"REG（NEWグリーン）",description:text,imageUrl:imgs[0]?.url||"",course:courseName,sourceUrl:pageUrl});
 }
 return rows.sort((a,b)=>a.hole-b.hole);
}
function parseGenericHole(html,pageUrl,title){
 const text=clean(html);
 const m=(title+" "+pageUrl).match(/(east|west|東|西)[^/]*?(?:no\.?\s*|_|-)(\d{1,2})/i)||text.match(/(east|west|東|西)\s*no\.?\s*(\d{1,2})/i);
 if(!m)return [];
 const hole=Number(m[2]);if(hole<1||hole>18)return [];
 const par=Number((text.match(/PAR\s*:?\s*(\d)/i)||[])[1]);
 const hdcp=Number((text.match(/HDCP\s*:?\s*(\d{1,2})/i)||[])[1]);
 const getReg=(green)=>{const re=new RegExp(green+"\\s*GREEN[\\s\\S]{0,100}?REGULAR\\s*:?\\s*(\\d{2,4})","i");return Number((text.match(re)||[])[1])||null;};
 const a=getReg("A"),b=getReg("B"),dist=a||b;
 if(!Number.isFinite(par)||!dist)return [];
 const imgs=extractImages(html,pageUrl);
 const image=imgs.find(x=>/(hole|course|layout|コース|ホール)/i.test(x.url+" "+x.alt))||imgs[0];
 const feature=(text.match(/特徴\s*:?\s*([\s\S]{0,700}?)(?:PAR\s*:?|HDCP\s*:?|A\s*GREEN|$)/i)||[])[1]||"";
 return [{hole,par,strokeIndex:Number.isFinite(hdcp)?hdcp:null,yards:dist,tee:a?"REG（Aグリーン）":"REG（Bグリーン）",description:feature.trim(),imageUrl:image?.url||"",course:/west|西/i.test(m[1])?"西コース":"東コース",sourceUrl:pageUrl,greenDistances:{A:a,B:b}}];
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
  return { title, url: page.href, links, images: extractImages(html, page.href), holes: [...parseHoleData(html,page.href,title), ...parseGenericHole(html,page.href,title)], via };
}
exports.handler = async (event) => {
  try {
    const raw = event.queryStringParameters?.page;
    if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ error: "公式サイトURLを指定してください" }) };
    const root = new URL(raw);
    if (!["http:", "https:"].includes(root.protocol) || root.hostname === "localhost" || root.hostname.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(root.hostname)) throw new Error("このURLは確認できません");
    const first = await getPage(root.href), rootData = parsePage(first.html, root.href, first.via);
    const pages = [], visited = new Set([root.href]);
    const rootHost=root.hostname.replace(/^www\\./,"");
    const queue=rootData.links.map(x=>({...x,depth:1}));
    const rawPages=[];
    while(queue.length&&visited.size<55){
      const item=queue.shift();if(visited.has(item.url))continue;
      const u=safeUrl(item.url,root.href);if(!u||u.hostname.replace(/^www\\./,"")!==rootHost)continue;
      visited.add(u.href);
      try{
        const fetched=await getPage(u.href),data=parsePage(fetched.html,u.href,fetched.via);
        rawPages.push(data);
        if(item.depth<3){
          const children=data.links
            .filter(x=>/(course|layout|hole|コース|レイアウト|ホール|east|west|東|西|no[._-]?\\d)/i.test(x.title+" "+x.url))
            .sort((a,b)=>Number(/no[._-]?\\d+/i.test(b.url))-Number(/no[._-]?\\d+/i.test(a.url)));
          for(const child of children)if(!visited.has(child.url)&&queue.length<80)queue.push({...child,depth:item.depth+1});
        }
      }catch(e){rawPages.push({title:item.title,url:item.url,links:[],images:[],holes:[],error:e.message});}
    }
    // Group single-hole detail pages into course books. Keep existing 9/18-hole UI contract.
    const grouped=new Map();
    for(const p of rawPages){
      for(const h of (p.holes||[])){
        const key=h.course||((p.title.match(/(東|西|East|West)/i)||[])[1]||"コース")+"コース";
        if(!grouped.has(key))grouped.set(key,{title:key,url:p.url,links:[],images:[],holes:[],via:p.via});
        const g=grouped.get(key);
        if(!g.holes.some(x=>Number(x.hole)===Number(h.hole)))g.holes.push(h);
        g.images.push(...p.images);
      }
    }
    for(const g of grouped.values()){g.holes.sort((a,b)=>a.hole-b.hole);pages.push(g);}
    // Retain full course guide pages that expose a valid 9+ hole table.
    for(const p of rawPages)if((p.holes||[]).length>=9&&!pages.some(g=>g.url===p.url))pages.push(p);
    const allImages = rawPages.flatMap(p => p.images.map(im => ({ ...im, pageTitle: p.title, pageUrl: p.url })));
    return { statusCode: 200, headers, body: JSON.stringify({ root: root.href, rootTitle: rootData.title, pages, images: allImages, scannedPages: visited.size, sourceMode: [...new Set([first.via,...pages.map(p=>p.via).filter(Boolean)])] }) };
  } catch (e) { return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || "サイトを調査できませんでした" }) }; }
};
