// フィード自動検出のローカル確認: node scripts/test-feed.js <url> ...
import { discover } from "../supabase/functions/feeds/feed.js";
for (const u of process.argv.slice(2)) {
  try {
    const list = await discover(u);
    console.log(`OK  ${u}  候補${list.length}件`);
    for (const f of list) {
      const it = f.items[0] || {};
      console.log(`    -> ${f.feedUrl}\n       ${f.title} | ${f.items.length}件 | ${it.published_at?.slice(0, 10)} | ${(it.title || "").slice(0, 30)}${f.unofficial ? " | 非公式: " + f.unofficial : ""}`);
    }
  } catch (e) { console.log(`NG  ${u}: ${e.message}`); }
}
