// Edge Function: フィード登録（自動検出）、全フィードの更新、記事の全文取得、AIダイジェスト
// 画面からの呼び出しは、ログインした本人の権限で DB を操作する（RLS で他人のデータには触れない）
// 毎朝の自動実行（morning）だけは管理者の鍵で動くので、すべての読み書きに user_id の条件を付ける
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { discover, fetchText, parseFeed, searchNews } from "./feed.js";
import { extractFullText } from "./fulltext.js";
import { makeDigest } from "./digest.js";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
type Db = SupabaseClient;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const KEEP_DAYS = 60;   // 既読かつお気に入りでない記事は、取り込んでからこの日数で削除
const MAX_ITEMS = 100;  // 1フィードから取り込む最大件数
const DIGEST_PER_DAY = 5;         // ダイジェストを作れる回数（1人1日）

// 日本時間の今日0時（UTC表記）
function jstToday() {
  const jst = 9 * 3600e3;
  return new Date(Math.floor((Date.now() + jst) / 864e5) * 864e5 - jst).toISOString();
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Item = { guid: string; title: string; link: string; author: string; content: string; image: string; published_at: string | null };

function rows(userId: string, feedId: string, items: Item[], since?: Date) {
  const seen = new Set<string>();
  const now = new Date().toISOString();
  return items
    .filter((it) => !since || !it.published_at || new Date(it.published_at) >= since)
    .filter((it) => it.guid && !seen.has(it.guid) && seen.add(it.guid))
    .slice(0, MAX_ITEMS)
    .map((it) => ({
      user_id: userId,
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

// 全フィードを再取得して新着を取り込み、古い既読記事を消す
async function refreshAll(db: Db, uid: string) {
  const { data: feeds, error } = await db.from("feeds").select("id,title,feed_url").eq("user_id", uid);
  if (error) throw error;
  const since = new Date(Date.now() - KEEP_DAYS * 864e5);

  const results = await pool(feeds ?? [], 6, async (feed) => {
    try {
      const page = await fetchText(feed.feed_url);
      const parsed = parseFeed(page.text, page.url);
      if (!parsed) throw new Error("フィードとして読めませんでした");
      const r = rows(uid, feed.id, parsed.items, since);
      let added = 0;
      if (r.length) {
        const { data, error } = await db.from("articles")
          .upsert(r, { onConflict: "feed_id,guid", ignoreDuplicates: true }).select("id");
        if (error) throw error;
        added = data?.length ?? 0;
      }
      await db.from("feeds").update({ fetched_at: new Date().toISOString(), last_error: null }).eq("id", feed.id).eq("user_id", uid);
      return { id: feed.id, added };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("feeds").update({ last_error: msg.slice(0, 300) }).eq("id", feed.id).eq("user_id", uid);
      return { id: feed.id, added: 0, error: `${feed.title}: ${msg}` };
    }
  });

  // 削除の基準は「取り込んだ日」。公開日にすると、登録時に取り込んだ古い記事が読んだ直後に消えてしまう
  await db.from("articles").delete()
    .eq("user_id", uid).eq("is_read", true).eq("is_starred", false).lt("created_at", since.toISOString());

  return {
    feeds: results.length,
    added: results.reduce((s, r) => s + r.added, 0),
    errors: results.filter((r) => r.error).map((r) => r.error),
  };
}

// 未読記事から AI がおすすめを選び、digests テーブルに保存する（ここだけがお金のかかる処理）
async function createDigest(db: Db, uid: string) {
  const { count, error: e1 } = await db.from("digests")
    .select("id", { count: "exact", head: true }).eq("user_id", uid).gte("created_at", jstToday());
  if (e1) throw e1;
  const used = count ?? 0;
  if (used >= DIGEST_PER_DAY) throw new HttpError(429, `ダイジェストは1日${DIGEST_PER_DAY}回までです`);

  // フォルダごとに新しい順で取り出し、まとめる（各フォルダから何件使うかは digest.js が決める）
  type Row = { id: string; folder_id: string | null; folder_name: string; folder_unread: number; feed_title: string; title: string; head: string };
  const { data: rows, error: e2 } = await db.rpc("digest_candidates", { per_folder: 300, for_user: uid });
  if (e2) throw e2;
  if (!rows?.length) throw new HttpError(400, "未読の記事がありません");
  const groups = new Map<string, { name: string; unread: number; articles: { id: string; feed: string; title: string; content: string }[] }>();
  for (const r of rows as Row[]) {
    const key = r.folder_id ?? "none";
    if (!groups.has(key)) groups.set(key, { name: r.folder_name, unread: Number(r.folder_unread), articles: [] });
    groups.get(key)!.articles.push({ id: r.id, feed: r.feed_title, title: r.title, content: r.head });
  }

  const d = await makeDigest([...groups.values()], { apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const { data: saved, error: e3 } = await db.from("digests").insert({
    user_id: uid, summary: d.summary, picks: d.picks, article_count: d.articleCount,
    input_tokens: d.usage.input_tokens, output_tokens: d.usage.output_tokens, stats: d.stats,
  }).select().single();
  if (e3) throw e3;
  return { digest: saved, remaining: DIGEST_PER_DAY - used - 1 };
}

// 毎朝の自動実行: フィードを更新してから、ダイジェストを作る
async function morning(uid: string) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const r = await refreshAll(db, uid);
    const d = await createDigest(db, uid);
    console.log(`morning ok user=${uid} added=${r.added} picks=${d.digest.picks.length}`);
  } catch (e) {
    console.error(`morning failed user=${uid}: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: { action?: string; url?: string; feeds?: string[]; folder_id?: string | null; id?: string; user_id?: string };
  try { body = await req.json(); } catch { body = {}; }

  // 定期実行（pg_cron）からの呼び出し。合言葉が合うときだけ受け付け、裏で処理してすぐ返事する
  if (body.action === "morning") {
    // コピー＆ペーストで紛れ込んだ前後の改行・空白は取り除いてから比べる
    const secret = Deno.env.get("CRON_SECRET")?.trim();
    if (!secret || req.headers.get("x-cron-secret")?.trim() !== secret) return json({ error: "forbidden" }, 403);
    if (!body.user_id) return json({ error: "user_id required" }, 400);
    EdgeRuntime.waitUntil(morning(body.user_id));
    return json({ accepted: true }, 202);
  }

  const auth = req.headers.get("Authorization") ?? "";
  // ブラウザが送ってくる公開用キー（sb_publishable_…）を優先。ログイン確認は下の getUser で行う
  const key = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY")!;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, key, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await db.auth.getUser(auth.replace(/^Bearer /, ""));
  if (!user) return json({ error: "ログインしてください" }, 401);

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
          const r = rows(user.id, feed.id, f.items);
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

    if (body.action === "refresh") return json(await refreshAll(db, user.id));

    // フィードに要約しかない記事を開いたとき、元ページから本文を抜き出して保存する
    if (body.action === "fulltext") {
      const { data: a, error } = await db.from("articles").select("id,link").eq("id", body.id).single();
      if (error || !a?.link) return json({ content: null });
      const full = await extractFullText(a.link).catch(() => null);
      if (!full) return json({ content: null });
      await db.from("articles").update({ content: full.content }).eq("id", a.id);
      return json({ content: full.content });
    }

    if (body.action === "digest") return json(await createDigest(db, user.id));

    // 記事の珍しい名詞で Google ニュースを検索し、ほかのサイトの関連記事を返す（保存はしない）
    if (body.action === "related_web") {
      const { data: words, error } = await db.rpc("article_keywords", { p_id: body.id, max_terms: 3 });
      if (error) throw error;
      if (!words?.length) return json({ words: [], items: [] });
      const { data: a } = await db.from("articles").select("title").eq("id", body.id).single();
      // 全部の単語を含む記事がなければ、単語を減らして検索し直す（3語 → 2語 → 1語）
      for (let n = words.length; n >= 1; n--) {
        const used = words.slice(0, n);
        const items = await searchNews(used, 5).catch(() => null);
        if (!items) return json({ words: used, items: [], error: "Google ニュースから取得できませんでした" });
        const hits = items.filter((x) => x.title !== a?.title).slice(0, 5);
        if (hits.length || n === 1) return json({ words: used, items: hits });
      }
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 400);
  }
});
