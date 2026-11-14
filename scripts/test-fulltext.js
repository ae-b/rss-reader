// 全文抽出のローカル確認: node scripts/test-fulltext.js <記事URL> ...
import { extractFullText } from "../supabase/functions/feeds/fulltext.js";
for (const u of process.argv.slice(2)) {
  try {
    const r = await extractFullText(u);
    console.log(r ? `OK  ${r.textLength}文字 画像${(r.content.match(/<img/g) || []).length}枚  ${u}` : `--  本文なし  ${u}`);
  } catch (e) { console.log(`NG  ${e.message}  ${u}`); }
}
