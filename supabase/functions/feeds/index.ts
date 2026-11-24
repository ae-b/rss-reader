// Edge Function: フィード登録（自動検出）、全フィードの更新、記事の全文取得、AIダイジェスト
// 呼び出したユーザーの権限で DB を操作するので、他人のデータには触れない
import { createClient } from "jsr:@supabase/supabase-js@2";
import { discover, fetchText, parseFeed } from "./feed.js";
import { extractFullText } from "./fulltext.js";
import { makeDigest } from "./digest.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const KEEP_DAYS = 60;   // 既読かつお気に入りでない記事はこの日数で削除
const MAX_ITEMS = 100;  // 1フィードから取り込む最大件数
const DIGEST_PER_DAY = 5;         // ダイジェストを作れる回数（1人1日）

// 日本時間の今日0時（UTC表記）
function jstToday() {
  const jst = 9 * 3600e3;
  return new Date(Math.floor((Date.now() + jst) / 864e5) * 864e5 - jst).toISOString();
}

type Item = { guid: string; title: string; link: string; author: string; content: string; image: string; published_at: string | null };

function rows(feedId: string, items: Item[], since?: Date) {
  const seen = new Set<string>();
  const now = new Date().toISOString();
  return items
    .filter((it) => !since || !it.published_at || new Date(it.published_at) >= since)
    .filter((it) => it.guid && !seen.has(it.guid) && seen.add(it.guid))
    .slice(0, MAX_ITEMS)
    .map((it) => ({
      feed_id: feedId,
      guid: it.guid.slice(0, 1000),
      title: it.title.slice(0, 500),
      link: it.link || null,
      author: it.author?.slice(0, 200) || null,
      content: (it.content || "").slice(0, 200_000),
      image: it.image || null,
      published_at: it.published_at || now,
    }));
}

async function pool<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>) {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k]); }
  }));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = req.headers.get("Authorization") ?? "";
  // ブラウザが送ってくる公開用キー（sb_publishable_…）を優先。ログイン確認は下の getUser で行う
  const key = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY")!;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, key, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await db.auth.getUser(auth.replace(/^Bearer /, ""));
  if (!user) return json({ error: "ログインしてください" }, 401);

  let body: { action?: string; url?: string; feeds?: string[]; folder_id?: string | null; id?: string };
  try { body = await req.json(); } catch { body = {}; }

  try {
    // 入力URLから読めるフィードの候補を探す（登録はしない）
    if (body.action === "discover") {
      const found = await discover(body.url ?? "");
      const { data: mine } = await db.from("feeds").select("feed_url").in("feed_url", found.map((f) => f.feedUrl));
      const registered = new Set((mine ?? []).map((f) => f.feed_url));
      return json({
        candidates: found.map((f) => ({
          feedUrl: f.feedUrl, title: f.title, siteUrl: f.siteUrl,
          count: f.items.length, newest: f.items[0]?.published_at ?? null,
          unofficial: f.unofficial ?? null, registered: registered.has(f.feedUrl),
        })),
      });
    }

    // 選ばれたフィードURLを登録し、今ある記事を取り込む
    if (body.action === "add") {
      const urls = [...new Set(body.feeds ?? [])].slice(0, 20);
      if (!urls.length) return json({ error: "登録するフィードを選んでください" }, 400);
      const feeds = [], skipped: string[] = [];
      let added = 0;
      for (const u of urls) {
        try {
          const page = await fetchText(u);
          const f = parseFeed(page.text, page.url);
          if (!f) throw new Error("フィードとして読めませんでした");
          const { data: dups } = await db.from("feeds").select("id,title").in("feed_url", [u, page.url]).limit(1);
          if (dups?.length) { skipped.push(`「${dups[0].title}」は登録済み`); continue; }

          const { data: feed, error } = await db.from("feeds").insert({
            title: f.title, site_url: f.siteUrl, feed_url: page.url,
            folder_id: body.folder_id || null, fetched_at: new Date().toISOString(),
          }).select().single();
          if (error) throw error;
          const r = rows(feed.id, f.items);
          if (r.length) {
            const { error: e2 } = await db.from("articles").upsert(r, { onConflict: "feed_id,guid", ignoreDuplicates: true });
            if (e2) throw e2;
          }
          feeds.push(feed);
          added += r.length;
        } catch (e) {
          skipped.push(`${u}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!feeds.length) return json({ error: skipped.join("\n") || "登録できませんでした" }, 400);
      return json({ feeds, added, skipped });
    }

    if (body.action === "refresh") {
      const { data: feeds, error } = await db.from("feeds").select("id,title,feed_url");
      if (error) throw error;
      const since = new Date(Date.now() - KEEP_DAYS * 864e5);

      const results = await pool(feeds ?? [], 6, async (feed) => {
        try {
          const page = await fetchText(feed.feed_url);
          const parsed = parseFeed(page.text, page.url);
          if (!parsed) throw new Error("フィードとして読めませんでした");
          const r = rows(feed.id, parsed.items, since);
          let added = 0;
          if (r.length) {
            const { data, error } = await db.from("articles")
              .upsert(r, { onConflict: "feed_id,guid", ignoreDuplicates: true }).select("id");
            if (error) throw error;
            added = data?.length ?? 0;
          }
          await db.from("feeds").update({ fetched_at: new Date().toISOString(), last_error: null }).eq("id", feed.id);
          return { id: feed.id, added };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await db.from("feeds").update({ last_error: msg.slice(0, 300) }).eq("id", feed.id);
          return { id: feed.id, added: 0, error: `${feed.title}: ${msg}` };
        }
      });

      await db.from("articles").delete()
        .eq("is_read", true).eq("is_starred", false).lt("published_at", since.toISOString());

      return json({
        feeds: results.length,
        added: results.reduce((s, r) => s + r.added, 0),
        errors: results.filter((r) => r.error).map((r) => r.error),
      });
    }

    // フィードに要約しかない記事を開いたとき、元ページから本文を抜き出して保存する
    if (body.action === "fulltext") {
      const { data: a, error } = await db.from("articles").select("id,link").eq("id", body.id).single();
      if (error || !a?.link) return json({ content: null });
      const full = await extractFullText(a.link).catch(() => null);
      if (!full) return json({ content: null });
      await db.from("articles").update({ content: full.content }).eq("id", a.id);
      return json({ content: full.content });
    }

    // 未読記事から AI がおすすめを選び、digests テーブルに保存する（ここだけがお金のかかる処理）
    if (body.action === "digest") {
      const { count, error: e1 } = await db.from("digests")
        .select("id", { count: "exact", head: true }).gte("created_at", jstToday());
      if (e1) throw e1;
      const used = count ?? 0;
      if (used >= DIGEST_PER_DAY) return json({ error: `ダイジェストは1日${DIGEST_PER_DAY}回までです` }, 429);

      // フォルダごとに新しい順で取り出し、まとめる（各フォルダから何件使うかは digest.js が決める）
      type Row = { id: string; folder_id: string | null; folder_name: string; folder_unread: number; feed_title: string; title: string; head: string };
      const { data: rows, error: e2 } = await db.rpc("digest_candidates", { per_folder: 300 });
      if (e2) throw e2;
      if (!rows?.length) return json({ error: "未読の記事がありません" }, 400);
      const groups = new Map<string, { name: string; unread: number; articles: { id: string; feed: string; title: string; content: string }[] }>();
      for (const r of rows as Row[]) {
        const key = r.folder_id ?? "none";
        if (!groups.has(key)) groups.set(key, { name: r.folder_name, unread: Number(r.folder_unread), articles: [] });
        groups.get(key)!.articles.push({ id: r.id, feed: r.feed_title, title: r.title, content: r.head });
      }

      const d = await makeDigest([...groups.values()], { apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
      const { data: saved, error: e3 } = await db.from("digests").insert({
        summary: d.summary, picks: d.picks, article_count: d.articleCount,
        input_tokens: d.usage.input_tokens, output_tokens: d.usage.output_tokens,
      }).select().single();
      if (e3) throw e3;
      return json({ digest: saved, remaining: DIGEST_PER_DAY - used - 1 });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
