// 前回コミット時のプロンプトと今のプロンプトを、同じ記事で比べる（どちらもフォルダ分けした記事を受け取る版）
// 実行: node --env-file=.env scripts/ai-digest-compare.js
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchText, parseFeed } from "../supabase/functions/feeds/feed.js";
import * as next from "../supabase/functions/feeds/digest.js";

// 古い digest.js を git から取り出して読み込む（.compare/ は Git の対象外）
mkdirSync(".compare", { recursive: true });
writeFileSync(".compare/digest-old.js", execSync("git show HEAD:supabase/functions/feeds/digest.js"));
const prev = await import("../.compare/digest-old.js");

// フォルダの代わり。unread は「未読が何件あるか」の想定値（あなたの例の数字）
const FOLDERS = [
  { name: "Social", unread: 210, feeds: ["https://festival-life.com/feed", "https://www.indienative.com/feed/", "https://popeyemagazine.jp/feed/podcast/popeye-web-podcast/", "https://www.switch-pub.co.jp/feed/"] },
  { name: "Tech", unread: 949, feeds: ["https://gigazine.net/news/rss_2.0/", "https://gihyo.jp/feed/rss2", "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml"] },
  { name: "アウトドア", unread: 243, feeds: ["https://www.funq.jp/feed/"] },
  { name: "ニュース", unread: 236, feeds: ["https://wired.jp/feed/rss", "https://www.nhk.or.jp/rss/news/cat0.xml"] },
];

const groups = [];
for (const f of FOLDERS) {
  const g = { name: f.name, unread: f.unread, articles: [] };
  for (const url of f.feeds) {
    try {
      const page = await fetchText(url);
      const feed = parseFeed(page.text, page.url);
      for (const it of feed.items) g.articles.push({ id: it.link || it.guid, feed: feed.title, title: it.title, content: it.content, at: it.published_at });
    } catch (e) { console.log(`（${url} は取得できず: ${e.message}）`); }
  }
  g.articles.sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));
  groups.push(g);
}
console.log(`記事 ${groups.reduce((n, g) => n + g.articles.length, 0)} 件で比べます\n`);

const apiKey = process.env.ANTHROPIC_API_KEY;
const tryIt = (f) => f().catch((e) => ({ error: e.message }));
const [a, b] = await Promise.all([
  tryIt(() => prev.makeDigest(groups, { apiKey })),
  tryIt(() => next.makeDigest(groups, { apiKey })),
]);

const byId = new Map(groups.flatMap((g) => g.articles).map((x) => [x.id, x]));
const yen = (u) => ((u.input_tokens * 0.10 + u.output_tokens * 0.50) / 1e6 * 150).toFixed(2);
function show(label, d) {
  console.log(`━━━━ ${label} ━━━━`);
  if (d.error) return console.log("エラー: " + d.error + "\n");
  console.log(d.summary + "\n");
  for (const p of d.picks) {
    const x = byId.get(p.article_id);
    console.log(`・${p.group ? `〔${p.group}〕` : ""}[${x.feed}] ${x.title}\n    → ${p.reason}`);
  }
  if (d.stats) console.log("\n  記録: " + d.stats.map((q) => `${q.name} 未読${q.unread}→入力${q.input}→指定${q.quota}→AI${q.returned}→採用${q.kept}`).join(" / "));
  const n = {};
  for (const p of d.picks) { const g = groups.find((g) => g.articles.some((x) => x.id === p.article_id)); n[g.name] = (n[g.name] ?? 0) + 1; }
  console.log("  実際に選ばれた数: " + Object.entries(n).map(([k, v]) => `${k} ${v}`).join(" / "));
  console.log(`  入力 ${d.usage.input_tokens} / 出力 ${d.usage.output_tokens} / 約${yen(d.usage)}円\n`);
}
show("前のプロンプト", a);
show("新しいプロンプト", b);
