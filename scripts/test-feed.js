// フィード自動検出のローカル確認: node scripts/test-feed.js <url> ...
import { discover } from "../supabase/functions/feeds/feed.js";
const urls = process.argv.slice(2);
for (const u of urls) {
  try {
    const f = await discover(u);
    const it = f.items[0] || {};
    console.log(`OK  ${u}\n    -> ${f.feedUrl}\n    ${f.title} | ${f.items.length}件 | ${it.title} | ${it.published_at} | img:${!!it.image} | content:${(it.content||"").length}`);
  } catch (e) { console.log(`NG  ${u}: ${e.message}`); }
}
