const { URL } = require("url");

function decodeHtml(value="") {
  return value.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">");
}
function absoluteUrl(src, base) {
  try { const u=new URL(src,base); return ["http:","https:"].includes(u.protocol)?u.href:""; } catch { return ""; }
}
exports.handler = async (event) => {
  const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-origin":"*"};
  try {
    if(event.queryStringParameters?.q) {
      const q=String(event.queryStringParameters.q).slice(0,120);
      const query=encodeURIComponent(q+" ゴルフ場 公式 コースレイアウト");
      const response=await fetch("https://html.duckduckgo.com/html/?q="+query,{headers:{"user-agent":"Mozilla/5.0 (compatible; GolfNotes/1.0)"}});
      if(!response.ok)throw new Error("検索サービスに接続できませんでした");
      const html=await response.text(),results=[],seen=new Set();
      const re=/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
      let m;
      while((m=re.exec(html))&&results.length<8){
        let url=decodeHtml(m[1]);
        try{const parsed=new URL(url);if(parsed.hostname.includes("duckduckgo.com")&&parsed.searchParams.has("uddg"))url=decodeURIComponent(parsed.searchParams.get("uddg"));}catch{}
        const title=decodeHtml(m[2].replace(/<[^>]*>/g,"").trim());
        let u;try{u=new URL(url);}catch{continue;}
        if(!["http:","https:"].includes(u.protocol)||seen.has(u.hostname))continue;
        seen.add(u.hostname);results.push({title,url:u.href,domain:u.hostname,snippet:decodeHtml((m[3]||"").replace(/<[^>]*>/g,"").trim())});
      }
      return {statusCode:200,headers,body:JSON.stringify({results})};
    }
    const page=event.queryStringParameters?.page;
    if(page){
      const u=new URL(page);
      if(!["http:","https:"].includes(u.protocol)||u.hostname==="localhost"||u.hostname.endsWith(".local")||/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname))throw new Error("このURLは確認できません");
      const response=await fetch(u.href,{headers:{"user-agent":"Mozilla/5.0 (compatible; GolfNotes/1.0)"},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error("公式ページを取得できませんでした");
      const html=(await response.text()).slice(0,2_000_000),images=[],seen=new Set();
      const imgRe=/<img\b([^>]+)>/gi;let m;
      while((m=imgRe.exec(html))&&images.length<15){
        const attrs=m[1],src=(attrs.match(/\bsrc=["']([^"']+)["']/i)||attrs.match(/\bdata-src=["']([^"']+)["']/i)||[])[1];
        if(!src)continue;
        const alt=(attrs.match(/\balt=["']([^"']*)["']/i)||[])[1]||"";
        const candidate=(src+" "+alt).toLowerCase();
        if(!/(course|layout|hole|map|コース|レイアウト|ホール|コース図|ヤーデージ)/i.test(candidate))continue;
        const imageUrl=absoluteUrl(src,u.href);if(!imageUrl||seen.has(imageUrl))continue;seen.add(imageUrl);
        images.push({url:imageUrl,alt:decodeHtml(alt)});
      }
      const meta=[...html.matchAll(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi)];
      for(const x of meta){const imageUrl=absoluteUrl(decodeHtml(x[1]),u.href);if(imageUrl&&!seen.has(imageUrl)){seen.add(imageUrl);images.unshift({url:imageUrl,alt:"ページのメイン画像"});}}
      return {statusCode:200,headers,body:JSON.stringify({page:u.href,images:images.slice(0,15)})};
    }
    return {statusCode:400,headers,body:JSON.stringify({error:"q または page を指定してください"})};
  } catch(error) {
    return {statusCode:400,headers,body:JSON.stringify({error:error.message||"検索エラー"})};
  }
};