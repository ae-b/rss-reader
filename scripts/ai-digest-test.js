// ダイジェストの試作（アプリと同じ digest.js を使う。データベースは使わない）
// 実行: node --env-file=.env scripts/ai-digest-test.js
import { fetchText, parseFeed } from "../supabase/functions/feeds/feed.js";
import { makeDigest } from "../supabase/functions/feeds/digest.js";

const FEEDS = [
  "https://www.nhk.or.jp/rss/news/cat0.xml",
  "https://www.asahi.com/rss/asahi/newsheadlines.rdf",
  "https://natgeo.nikkeibp.co.jp/nng/rss/index.rdf",
];
const PER_FEED = 20;

const articles = [];
for (const url of FEEDS) {
  const page = await fetchText(url);
  const feed = parseFeed(page.text, page.url);
  for (const it of feed.items.slice(0, PER_FEED)) {
    articles.push({ id: it.link, feed: feed.title, title: it.title, content: it.content });
  }
}
console.log(`記事 ${articles.length} 件を集めました\n`);

const d = await makeDigest(articles, { apiKey: process.env.ANTHROPIC_API_KEY });

console.log("■ まとめ\n" + d.summary + "\n");
console.log("■ おすすめ");
const byId = new Map(articles.map((a) => [a.id, a]));
for (const p of d.picks) {
  const a = byId.get(p.article_id);
  console.log(`  ・[${a.feed}] ${a.title}\n    → ${p.reason}`);
}

const u = d.usage;
const cost = u.input_tokens * 0.10 / 1e6 + u.output_tokens * 0.50 / 1e6;
console.log(`\n■ 使った量\n  入力 ${u.input_tokens} / 出力 ${u.output_tokens}（うち考えた量 ${u.output_tokens_details?.thinking_tokens ?? 0}）`);
console.log(`  料金 約$${cost.toFixed(5)}（約${(cost * 150).toFixed(2)}円）`);
