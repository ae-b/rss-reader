// Edge Function: フィード登録（自動検出）と全フィードの更新
// 呼び出したユーザーの権限で DB を操作するので、他人のデータには触れない
import { createClient } from "jsr:@supabase/supabase-js@2";
import { discover, fetchText, parseFeed } from "./feed.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const KEEP_DAYS = 60;   // 既読かつお気に入りでない記事はこの日数で削除
const MAX_ITEMS = 100;  // 1フィードから取り込む最大件数

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
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await db.auth.getUser(auth.replace(/^Bearer /, ""));
  if (!user) return json({ error: "ログインしてください" }, 401);

  let body: { action?: string; url?: string; folder_id?: string | null };
  try { body = await req.json(); } catch { body = {}; }

  try {
    if (body.action === "add") {
      const f = await discover(body.url ?? "");
      const { data: dup } = await db.from("feeds").select("id,title").eq("feed_url", f.feedUrl).maybeSingle();
      if (dup) return json({ error: `「${dup.title}」はすでに登録されています` }, 409);

      const { data: feed, error } = await db.from("feeds").insert({
        title: f.title, site_url: f.siteUrl, feed_url: f.feedUrl,
        folder_id: body.folder_id || null, fetched_at: new Date().toISOString(),
      }).select().single();
      if (error) throw error;
      const r = rows(feed.id, f.items);
      if (r.length) {
        const { error: e2 } = await db.from("articles").upsert(r, { onConflict: "feed_id,guid", ignoreDuplicates: true });
        if (e2) throw e2;
      }
      return json({ feed, added: r.length });
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

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
