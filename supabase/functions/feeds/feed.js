// フィードの取得・解析・自動検出（Edge Function と ローカルテストの両方で使う）
import { XMLParser } from "fast-xml-parser";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAX_BYTES = 5 * 1024 * 1024;

export function normalizeUrl(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("URLを入力してください");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  const h = u.hostname;
  if (
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
    h.startsWith("[")
  ) throw new Error("このURLは登録できません");
  return u.href;
}

// 文字コードを判定してテキストにする（Shift_JIS / EUC-JP のフィードにも対応）
function decode(bytes, contentType) {
  let cs = (contentType.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    cs = (head.match(/<\?xml[^>]*encoding=["']([\w-]+)/i) ||
      head.match(/<meta[^>]*charset=["']?([\w-]+)/i) || [])[1];
  }
  try {
    return new TextDecoder(cs || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchText(url, timeoutMs = 12000) {
  const res = await fetch(normalizeUrl(url), {
    headers: {
      "User-Agent": UA,
      "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`取得に失敗しました (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("ファイルが大きすぎます");
  return { text: decode(buf, res.headers.get("content-type") || ""), url: res.url || url };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ["item", "entry", "link"].includes(name),
});

const first = (v) => (Array.isArray(v) ? v[0] : v);
function txt(v) {
  v = first(v);
  if (v == null) return "";
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
}
const stripTags = (s) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

function abs(href, base) {
  if (!href) return "";
  try { return new URL(href, base).href; } catch { return ""; }
}

function toDate(...cands) {
  for (const c of cands) {
    const s = txt(c);
    if (!s) continue;
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString();
  }
  return null;
}

function firstImg(html, base) {
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? abs(m[1].replace(/&amp;/g, "&"), base) : "";
}

function mediaImage(it) {
  const g = first(it["media:group"]) || {};
  for (const node of [it["media:thumbnail"], g["media:thumbnail"], it["media:content"], g["media:content"]]) {
    const n = first(node);
    if (n && n["@_url"] && (!n["@_medium"] || n["@_medium"] === "image")) return n["@_url"];
  }
  for (const e of [].concat(it.enclosure || [])) {
    if (e && e["@_url"] && /^image\//.test(e["@_type"] || "")) return e["@_url"];
  }
  return "";
}

function atomLink(links, rel = "alternate") {
  links = [].concat(links || []);
  const l = links.find((x) => typeof x === "object" && (x["@_rel"] || "alternate") === rel) ||
    (rel === "alternate" ? links[0] : null);
  if (!l) return "";
  return typeof l === "object" ? (l["@_href"] || txt(l)) : String(l);
}

// XML がフィードなら { title, siteUrl, items } を返す。フィードでなければ null
export function parseFeed(xml, baseUrl) {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 5000))) return null;
  let doc;
  try { doc = parser.parse(xml); } catch { return null; }

  const items = [];
  let title = "", siteUrl = "";

  if (doc.rss || doc["rdf:RDF"]) {
    const root = doc.rss || doc["rdf:RDF"];
    const ch = first(root.channel) || {};
    title = stripTags(txt(ch.title));
    siteUrl = abs(txt(ch.link), baseUrl);
    const list = [].concat(ch.item || root.item || []);
    for (const it of list) {
      const link = abs(txt(it.link) || (it.guid && txt(it.guid).startsWith("http") ? txt(it.guid) : ""), baseUrl);
      const content = txt(it["content:encoded"]) || txt(it.description);
      items.push({
        guid: txt(it.guid) || it["@_rdf:about"] || link || txt(it.title),
        title: stripTags(txt(it.title)) || "(無題)",
        link,
        author: stripTags(txt(it["dc:creator"]) || txt(it.author)),
        content,
        image: abs(mediaImage(it), link || baseUrl) || firstImg(content, link || baseUrl),
        published_at: toDate(it.pubDate, it["dc:date"], it.published, it.updated),
      });
    }
  } else if (doc.feed) {
    const f = doc.feed;
    title = stripTags(txt(f.title));
    siteUrl = abs(atomLink(f.link), baseUrl);
    for (const it of [].concat(f.entry || [])) {
      const link = abs(atomLink(it.link), baseUrl);
      const g = first(it["media:group"]) || {};
      let content = txt(it.content) || txt(it.summary);
      const mdesc = txt(g["media:description"]);
      if (!content && mdesc) content = mdesc.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/\n/g, "<br>");
      const a = first(it.author);
      items.push({
        guid: txt(it.id) || link || txt(it.title),
        title: stripTags(txt(it.title)) || "(無題)",
        link,
        author: stripTags(a && typeof a === "object" ? txt(a.name) : txt(a)),
        content,
        image: abs(mediaImage(it), link || baseUrl) || firstImg(content, link || baseUrl),
        published_at: toDate(it.published, it.updated, it["dc:date"]),
      });
    }
  } else {
    return null;
  }

  return { title: title || new URL(baseUrl).hostname, siteUrl: siteUrl || new URL(baseUrl).origin, items };
}

// HTML の <link rel="alternate" type="application/rss+xml"> を探す
function findFeedLinks(html, base) {
  const out = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").replace(/&amp;/g, "&");
    }
    if (/\balternate\b/i.test(attrs.rel || "") && /(rss|atom|rdf)\+xml|application\/(xml|feed\+json)/i.test(attrs.type || "") && attrs.href) {
      if (/comments/i.test(attrs.href) || /コメント|comments/i.test(attrs.title || "")) continue;
      const u = abs(attrs.href, base);
      if (u && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

// ページ内の <a href> のうち、フィードやフィード一覧ページらしいもの
function findAnchorLinks(html, base) {
  const out = [];
  const host = new URL(base).hostname.split(".").slice(-2).join(".");
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (!/(rss|feed|atom)|\.(xml|rdf)(\?|$)/i.test(href) || /comment|utm_|sitemap/i.test(href)) continue;
    const u = abs(href, base);
    if (u && new URL(u).hostname.endsWith(host) && !out.includes(u)) out.push(u);
  }
  return out;
}

// Shopify のショップ：ページ内の /blogs/○○ へのリンクから、各ブログの Atom フィードを作る
function findShopifyBlogs(html, base) {
  if (!/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(html)) return [];
  const origin = new URL(base).origin;
  const names = new Set();
  for (const m of html.matchAll(/href=["'](?:https?:\/\/[^/"']+)?\/blogs\/([a-z0-9_-]+)/gi)) names.add(m[1].toLowerCase());
  return [...names].map((n) => `${origin}/blogs/${n}.atom`);
}

// 自動検出の手がかりをページに出していないサイト（Feedly などで知られているフィード）
// unofficial: サイト運営者ではない第三者が作っているフィード
const KNOWN = [
  { host: /(^|\.)nhk\.or\.jp$|^news\.web\.nhk$/, feeds: ["https://www.nhk.or.jp/rss/news/cat0.xml"] },
  { host: /(^|\.)asahi\.com$/, feeds: ["https://www.asahi.com/rss/asahi/newsheadlines.rdf"] },
  { host: /(^|\.)natgeo\.nikkeibp\.co\.jp$|(^|\.)nationalgeographic\.jp$/, feeds: ["https://natgeo.nikkeibp.co.jp/nng/rss/index.rdf"] },
  { host: /(^|\.)openai\.com$/, feeds: ["https://openai.com/news/rss.xml"] },
  {
    host: /(^|\.)47news\.jp$/, unofficial: "wor.jp",
    feeds: ["https://assets.wor.jp/rss/rdf/ynnews/news.rdf", "https://assets.wor.jp/rss/rdf/ynlocalnews/news.rdf"],
  },
  {
    host: /(^|\.)anthropic\.com$/, unofficial: "GitHub の有志（Olshansk/rss-feeds）",
    feeds: [
      "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml",
      "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_engineering.xml",
      "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_research.xml",
    ],
  },
];

const COMMON_PATHS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/index.rdf", "/rss2.xml", "/?feed=rss2"];
const MAX_CANDIDATES = 10;

function blockedMessage(err) {
  const code = (String(err?.message).match(/HTTP (\d+)/) || [])[1];
  if (["401", "403", "429"].includes(code)) {
    return `このサイトはプログラムからのアクセスを制限しているため読み込めません（HTTP ${code}）`;
  }
  return err?.message || "取得に失敗しました";
}

// 入力されたURLから、読めるフィードの候補を探す
// 戻り値: [{ feedUrl, title, siteUrl, items, unofficial? }]（見つからなければ例外）
export async function discover(input) {
  const url = normalizeUrl(input);
  const host = new URL(url).hostname;
  const known = KNOWN.find((k) => k.host.test(host));

  const tried = new Map();
  const tryUrl = (u) => {
    if (!tried.has(u)) {
      tried.set(u, fetchText(u, 8000).then((r) => {
        const f = parseFeed(r.text, r.url);
        return f ? { feed: { feedUrl: r.url, ...f } } : { html: r.text, url: r.url };
      }).catch(() => ({})));
    }
    return tried.get(u);
  };
  let empty = null; // 記事0件のフィードは最後の手段
  // 渡したURLのうち、記事のあるフィードを全部返す（同じフィードは1つに）
  const collect = async (urls, extra = {}) => {
    const res = await Promise.all(urls.slice(0, MAX_CANDIDATES).map(tryUrl));
    const out = [];
    for (const r of res) {
      if (r.feed?.items.length && !out.some((f) => f.feedUrl === r.feed.feedUrl)) out.push({ ...r.feed, ...extra });
      else if (r.feed && !empty) empty = r.feed;
    }
    return Object.assign(out, { pages: res.filter((r) => r.html) });
  };
  const fromKnown = () => known ? collect(known.feeds, known.unofficial ? { unofficial: known.unofficial } : {}) : [];

  let page;
  try {
    page = await fetchText(url);
  } catch (e) {
    // ページ自体が読めなくても、既知のフィードがあればそれを使う
    const r = await fromKnown();
    if (r.length) return r;
    throw new Error(blockedMessage(e));
  }
  const direct = parseFeed(page.text, page.url);
  if (direct) return [{ feedUrl: page.url, ...direct }];

  // 1. <link rel="alternate">  2. 既知サイト  3. Shopify のブログ
  // 4. ページ内のRSSリンク（一覧ページなら1段だけ辿る）  5. よくあるパス
  let r = await collect(findFeedLinks(page.text, page.url));
  if (r.length) return r;
  if ((r = await fromKnown()).length) return r;
  if ((r = await collect(findShopifyBlogs(page.text, page.url))).length) return r;

  r = await collect(findAnchorLinks(page.text, page.url));
  if (r.length) return r;
  for (const p of r.pages.slice(0, 3)) {
    const sub = [...findFeedLinks(p.html, p.url), ...findAnchorLinks(p.html, p.url).filter((u) => /\.(xml|rdf)(\?|$)|feed/i.test(u))];
    const found = await collect(sub);
    if (found.length) return found;
  }

  const base = new URL(page.url);
  const dirs = [base.pathname.replace(/\/[^/]*$/, ""), ""].filter((d, i, a) => a.indexOf(d) === i);
  for (const d of dirs) {
    if ((r = await collect(COMMON_PATHS.map((p) => base.origin + d + p))).length) return r.slice(0, 1);
  }
  if (empty) return [empty];
  throw new Error("このページからRSS/Atomフィードが見つかりませんでした");
}

// Google ニュースの検索RSS（正式なAPIではないので、取れなくなったら空で返す）
// 戻り値: [{ title, link, source, sourceUrl, published_at }]
export async function searchNews(words, max = 5) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(words.join(" "))}&hl=ja&gl=JP&ceid=JP:ja`;
  const page = await fetchText(url, 8000);
  let doc;
  try { doc = parser.parse(page.text); } catch { return []; }
  const items = [].concat(doc?.rss?.channel?.item || []);
  return items.slice(0, max * 2).map((it) => {
    const src = first(it.source);
    const source = txt(src);
    let title = stripTags(txt(it.title));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return {
      title, link: txt(it.link), source,
      sourceUrl: (typeof src === "object" && src["@_url"]) || "",
      published_at: toDate(it.pubDate),
    };
  }).filter((x) => x.title && x.link);
}
