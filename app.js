// RSSリーダー 本体
const PAGE = 50;
const DIGEST_PER_DAY = 5; // 表示用。実際の制限は Edge Function 側で行う
const ARTICLE_COLS = "id,feed_id,title,link,author,image,published_at,is_read,is_starred";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isMobile = () => matchMedia("(max-width: 700px)").matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  folders: [], feeds: [], counts: {},
  view: store.get("view", { type: "all" }),
  articles: [], done: false, loading: false, seq: 0,
  current: null,
  unreadOnly: store.get("unreadOnly", false),
  closed: new Set(store.get("closedFolders", [])),
  refreshing: null,
  webRelated: new Map(),  // 記事id → Google ニュースの結果（同じ記事を開き直しても問い合わせない）
};
let sb;

// ---------- 起動・ログイン ----------
async function init() {
  const cfg = window.RSS_CONFIG || {};
  if (!cfg.url || !cfg.anonKey || cfg.url.includes("YOUR_")) {
    $("#login").hidden = false;
    $("#google-login").hidden = true;
    $("#login-msg").textContent = "config.js に Supabase の URL と anon key を設定してください。";
    return;
  }
  sb = supabase.createClient(cfg.url, cfg.anonKey);
  $("#google-login").onclick = () => sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });

  const { data: { session } } = await sb.auth.getSession();
  const authError = /error_description=/.test(location.search + location.hash);
  if (location.hash.includes("access_token") || authError) history.replaceState(null, "", location.pathname);
  if (!session) {
    $("#login").hidden = false;
    // 許可リストにないアカウントは登録時に拒否される
    if (authError) $("#login-msg").textContent = "このGoogleアカウントでは利用できません。";
    return;
  }
  start(session.user);
}

async function start(user) {
  $("#app").hidden = false;
  $("#user-email").textContent = user.email || "";
  $("#unread-only").checked = state.unreadOnly;
  bindUI();
  await loadSidebar();
  await loadList(true);
  refreshFeeds(); // 開くたび（PCはリロードで）全フィードを再取得
}

// ---------- サーバー ----------
// Supabase 側の一時的な不調（応答なし・503 など）は、少し待って2回までやり直す
const TRANSIENT_STATUS = [502, 503, 504, 546];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callFn(body) {
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await sb.functions.invoke("feeds", { body });
    if (!error) return data;
    const transient = error.name === "FunctionsFetchError" || error.name === "FunctionsRelayError" ||
      TRANSIENT_STATUS.includes(error.context?.status);
    if (transient && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    if (transient) throw new Error("サーバーが一時的に不調です。少し待ってもう一度お試しください");
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch {}
    throw new Error(msg);
  }
}

async function loadSidebar() {
  const [fo, fe, co] = await Promise.all([
    sb.from("folders").select("*").order("name"),
    sb.from("feeds").select("*").order("title"),
    sb.rpc("unread_counts"),
  ]);
  if (fo.error || fe.error) return toast("読み込みに失敗しました");
  state.folders = fo.data;
  state.feeds = fe.data;
  state.counts = Object.fromEntries((co.data || []).map((r) => [r.feed_id, Number(r.unread)]));
  const v = state.view;
  if ((v.type === "feed" && !feedById(v.id)) || (v.type === "folder" && !state.folders.some((f) => f.id === v.id))) {
    state.view = { type: "all" };
  }
  renderNav();
}

const feedById = (id) => state.feeds.find((f) => f.id === id);
const feedsIn = (folderId) => state.feeds.filter((f) => (f.folder_id || null) === folderId);
const countOf = (feeds) => feeds.reduce((s, f) => s + (state.counts[f.id] || 0), 0);

function viewFilter(q) {
  const v = state.view;
  if (v.type === "starred") q = q.eq("is_starred", true);
  if (v.type === "feed") q = q.eq("feed_id", v.id);
  if (v.type === "folder") q = q.in("feed_id", feedsIn(v.id).map((f) => f.id));
  return q;
}

async function loadList(reset) {
  if (reset) {
    state.articles = []; state.done = false; state.seq++;
    $("#list").innerHTML = "";
    $("#list-scroll").scrollTop = 0;
    const digest = state.view.type === "digest";
    $("#digest-head").hidden = !digest;
    $("#unread-toggle").hidden = digest;
    $("#mark-all-btn").hidden = digest;
  }
  if (state.view.type === "digest") return reset ? loadDigest() : undefined;
  if (state.loading && !reset) return;
  if (state.done) return;
  if (state.view.type === "folder" && !feedsIn(state.view.id).length) {
    state.done = true; return renderListFoot();
  }
  const seq = state.seq;
  state.loading = true;
  $("#list-foot").textContent = "読み込み中…";
  let q = sb.from("articles")
    .select(ARTICLE_COLS)
    .order("published_at", { ascending: false }).order("id")
    .range(state.articles.length, state.articles.length + PAGE - 1);
  q = viewFilter(q);
  if (state.unreadOnly) q = q.eq("is_read", false);
  const { data, error } = await q;
  if (seq !== state.seq) return;
  state.loading = false;
  if (error) { $("#list-foot").textContent = "読み込みに失敗しました"; return; }
  state.articles.push(...data);
  if (data.length < PAGE) state.done = true;
  $("#list").insertAdjacentHTML("beforeend", data.map(itemHtml).join(""));
  renderListFoot();
}

// ---------- 今朝のダイジェスト ----------
// 見るのは digests テーブルを読むだけ（無料）。AIを呼ぶのは「作る」を押したときだけ
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function loadDigest() {
  const seq = state.seq;
  state.done = true;
  $("#list-foot").textContent = "読み込み中…";
  const [dg, cnt] = await Promise.all([
    sb.from("digests").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("digests").select("id", { count: "exact", head: true }).gte("created_at", todayStart()),
  ]);
  if (seq !== state.seq) return;
  const d = dg.data;
  let arts = [];
  if (d?.picks.length) {
    const { data } = await sb.from("articles").select(ARTICLE_COLS).in("id", d.picks.map((p) => p.article_id));
    if (seq !== state.seq) return;
    const byId = new Map((data || []).map((a) => [a.id, a]));
    arts = d.picks.filter((p) => byId.has(p.article_id)).map((p) => ({ ...byId.get(p.article_id), reason: p.reason, group: p.group }));
  }
  state.articles = arts;
  renderDigestHead(d, DIGEST_PER_DAY - (cnt.count ?? 0));
  $("#list").innerHTML = arts.map(itemHtml).join("");
  $("#list-foot").textContent = d && !arts.length ? "選ばれた記事は削除されています" : "";
}

// 毎朝 6:50 に自動で作られるので、ボタンは自動作成に失敗した日（7:00 を過ぎても今日の分がない）だけ出す
const MORNING_DEADLINE = 7;

function renderDigestHead(d, remaining) {
  const made = d && new Date(d.created_at);
  const today = made && made >= new Date(todayStart());
  const hm = (t) => t.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  const failed = !today && new Date().getHours() >= MORNING_DEADLINE;

  const status = today
    ? `☀️ ${made.getHours() < 9 ? "今朝" : "今日"} ${hm(made)} に作成済み · 未読${d.article_count}件から選びました`
    : failed
      ? `⚠️ 今朝の自動作成ができませんでした${d ? `（表示中は ${fullTime(d.created_at)} の分）` : ""}`
      : `${d ? `${fullTime(d.created_at)} の分を表示中 · ` : ""}次は 6:50 に自動で作成されます`;

  $("#digest-head").innerHTML =
    (d ? `<p class="summary">${esc(d.summary)}</p>` : "") +
    `<div class="dmeta">${status}</div>` +
    (failed
      ? `<div class="dactions">
           <button class="btn primary small" id="digest-make"${remaining > 0 ? "" : " disabled"}>今すぐ作る</button>
           <span>今日あと${Math.max(0, remaining)}回</span>
         </div>`
      : "");
}

async function makeDigest(btn) {
  btn.disabled = true;
  btn.textContent = "AIが選んでいます…";
  try {
    await callFn({ action: "digest" });
    if (state.view.type === "digest") await loadList(true);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = "今すぐ作る";
  }
}

function renderListFoot() {
  const n = state.articles.length;
  $("#list-foot").innerHTML = n
    ? (state.done ? "これ以上ありません" : "")
    : `<div class="empty">${state.feeds.length ? (state.unreadOnly ? "未読の記事はありません" : "記事がありません") : "右上の「＋ 追加」からサイトを登録しましょう"}</div>`;
}

// ---------- 描画 ----------
function favicon(feed) {
  try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(feed.site_url || feed.feed_url).hostname}`; } catch { return ""; }
}

function navItem({ key, label, count, icon = "", active, more = "", err = "", caret = "" }) {
  return `<div class="nav-item${active ? " active" : ""}" data-nav="${key}" role="button" tabindex="0">
    ${caret}${icon}<span class="name">${esc(label)}</span>${err}
    ${count ? `<span class="count">${count}</span>` : ""}${more}</div>`;
}

function renderNav() {
  const v = state.view;
  const is = (t, id) => v.type === t && (id == null || v.id === id);
  const feedRow = (f) => navItem({
    key: `feed:${f.id}`, label: f.title, count: state.counts[f.id], active: is("feed", f.id),
    icon: `<img class="fav" src="${favicon(f)}" alt="" loading="lazy" referrerpolicy="no-referrer">`,
    err: f.last_error ? `<span class="err" title="${esc(f.last_error)}">⚠</span>` : "",
    more: `<button class="more" data-edit-feed="${f.id}" aria-label="設定">…</button>`,
  });

  let html = navItem({ key: "digest", label: "今朝のダイジェスト", active: is("digest"), icon: "☀️" });
  html += navItem({ key: "all", label: "すべて", count: countOf(state.feeds), active: is("all"), icon: "📰" });
  html += navItem({ key: "starred", label: "お気に入り", active: is("starred"), icon: "⭐" });

  if (state.folders.length) html += `<div class="nav-label">フォルダ</div>`;
  for (const fo of state.folders) {
    const kids = feedsIn(fo.id);
    const closed = state.closed.has(fo.id);
    html += `<div class="nav-group">` + navItem({
      key: `folder:${fo.id}`, label: fo.name, count: countOf(kids), active: is("folder", fo.id), icon: "📁",
      caret: `<span class="caret${closed ? " closed" : ""}" data-toggle="${fo.id}">▼</span>`,
      more: `<button class="more" data-edit-folder="${fo.id}" aria-label="設定">…</button>`,
    }) + (closed ? "" : `<div class="nav-children">${kids.map(feedRow).join("")}</div>`) + `</div>`;
  }
  const loose = feedsIn(null);
  if (loose.length) {
    if (state.folders.length) html += `<div class="nav-label">フォルダなし</div>`;
    else html += `<div class="nav-label">フィード</div>`;
    html += loose.map(feedRow).join("");
  }
  $("#nav").innerHTML = html;
  $("#view-title").textContent = viewTitle();
}

function viewTitle() {
  const v = state.view;
  if (v.type === "digest") return "今朝のダイジェスト";
  if (v.type === "starred") return "お気に入り";
  if (v.type === "feed") return feedById(v.id)?.title || "";
  if (v.type === "folder") return state.folders.find((f) => f.id === v.id)?.name || "";
  return "すべて";
}

function relTime(iso) {
  const d = new Date(iso), diff = (Date.now() - d) / 60000;
  if (diff < 1) return "たった今";
  if (diff < 60) return `${Math.floor(diff)}分前`;
  if (diff < 1440) return `${Math.floor(diff / 60)}時間前`;
  if (diff < 1440 * 7) return `${Math.floor(diff / 1440)}日前`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? "" : d.getFullYear() + "/"}${d.getMonth() + 1}/${d.getDate()}`;
}
const fullTime = (iso) => new Date(iso).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });

function itemHtml(a) {
  const feed = feedById(a.feed_id);
  return `<li class="item${a.is_read ? " read" : ""}${state.current?.id === a.id ? " active" : ""}" data-id="${a.id}">
    <span class="dot"></span>
    <div class="main">
      <div class="title">${esc(a.title)}</div>
      <div class="meta"><span class="src">${esc(feed?.title || "")}</span><span>${relTime(a.published_at)}</span></div>
      ${a.reason ? `<div class="reason">${a.group ? `〔${esc(a.group)}〕` : "→ "}${esc(a.reason)}</div>` : ""}
    </div>
    ${a.image ? `<img class="thumb" src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
    <button class="star${a.is_starred ? " on" : ""}" data-star="${a.id}" aria-label="お気に入り">${a.is_starred ? "★" : "☆"}</button>
  </li>`;
}

function updateItem(a) {
  const li = document.querySelector(`.item[data-id="${a.id}"]`);
  if (li) li.outerHTML = itemHtml(a);
  if (state.current?.id === a.id) renderReaderBar();
}

// ---------- 記事を読む ----------
function youtubeId(link) {
  const m = (link || "").match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m && m[1];
}

function cleanHtml(html, base) {
  const clean = DOMPurify.sanitize(html || "", {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "class", "id", "width", "height"],
  });
  const box = document.createElement("div");
  box.innerHTML = clean;
  const fix = (u) => { try { return new URL(u, base).href; } catch { return u; } };
  for (const img of box.querySelectorAll("img")) {
    const src = img.getAttribute("src") || img.dataset.src || img.dataset.lazySrc || img.dataset.original;
    if (!src) { img.remove(); continue; }
    img.src = fix(src);
    img.removeAttribute("srcset");
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
  }
  for (const a of box.querySelectorAll("a[href]")) {
    a.href = fix(a.getAttribute("href"));
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return box;
}

async function openArticle(id) {
  const a = state.articles.find((x) => x.id === id);
  if (!a) return;
  relatedObserver?.disconnect();  // 前の記事の関連記事の見張りは止める
  state.current = a;
  document.querySelectorAll(".item.active").forEach((el) => el.classList.remove("active"));
  document.querySelector(`.item[data-id="${id}"]`)?.classList.add("active");

  if (isMobile() && !$("#app").classList.contains("reading")) {
    $("#app").classList.add("reading");
    history.pushState({ reader: 1 }, "");
  }
  const body = $("#reader-body");
  body.innerHTML = `<div class="empty">読み込み中…</div>`;
  $("#reader").classList.add("has-article");
  renderReaderBar();
  if (!a.is_read) setRead(a, true);

  const { data } = await sb.from("articles").select("content").eq("id", id).single();
  if (state.current?.id !== id) return;
  const short = renderArticle(a, data?.content);

  // フィードに要約しかない記事は、元ページから全文を取ってきて差し替える
  if (short && a.link && !youtubeId(a.link)) {
    const note = body.querySelector(".more-box .muted");
    if (note) note.textContent = "全文を読み込み中…";
    const r = await callFn({ action: "fulltext", id }).catch(() => null);
    if (state.current?.id !== id) return;
    if (r?.content) {
      const top = body.scrollTop;
      renderArticle(a, r.content);
      body.scrollTop = top;
    } else if (note) {
      note.textContent = "全文を取得できませんでした。続きは元記事でどうぞ。";
    }
  }
  // 本文が確定してから、関連記事の欄の見張りを始める（全文の読み込み中に欄が見えても検索しない）
  watchRelated();
}

// 本文を描画する。本文が短い（フィードに要約しかない）とき true を返す
function renderArticle(a, html) {
  const body = $("#reader-body");
  const feed = feedById(a.feed_id);
  const content = cleanHtml(html, a.link || feed?.site_url);
  const yt = youtubeId(a.link);
  const hasImg = content.querySelector("img");
  const text = content.textContent.trim();
  const short = text.length < 400;

  body.innerHTML = `<div class="article">
    <h1><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a></h1>
    <div class="ameta">${esc(feed?.title || "")}${a.author ? " · " + esc(a.author) : ""} · ${fullTime(a.published_at)}</div>
    ${yt ? `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${yt}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`
      : (!hasImg && a.image ? `<img class="cover" src="${esc(a.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : "")}
    <div class="content"></div>
    <div class="more-box">
      ${short ? `<p class="muted">フィードには記事の一部だけが含まれています。</p>` : ""}
      <a class="btn primary" href="${esc(a.link)}" target="_blank" rel="noopener">元記事を読む ↗</a>
    </div>
    <section class="related"><h2>関連する記事</h2></section>
  </div>`;
  body.querySelector(".content").append(...content.childNodes);
  body.scrollTop = 0;
  renderRelated();
  return short;
}

// ほかのサイトの関連記事（Google ニュース）。欄までスクロールしたときだけ問い合わせる
let relatedObserver;

function watchRelated() {
  const box = $("#reader-body .related");
  const id = state.current?.id;
  if (!box || !id) return;
  if (state.webRelated.has(id)) return renderRelated();
  relatedObserver?.disconnect();
  relatedObserver = new IntersectionObserver(async (entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    relatedObserver.disconnect();
    if (!state.webRelated.has(id)) {
      box.insertAdjacentHTML("beforeend", `<p class="muted">ほかのサイトから探しています…</p>`);
      const r = await callFn({ action: "related_web", id }).catch((e) => ({ items: [], error: e.message }));
      state.webRelated.set(id, r);
    }
    if (state.current?.id === id) renderRelated();
  }, { threshold: 0.5 });  // 欄が半分以上見えたら（= 一番下までスクロールしたら）
  relatedObserver.observe(box);
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

function renderRelated() {
  const box = $("#reader-body .related");
  const r = state.webRelated.get(state.current?.id);
  if (!box || !r) return;
  const mine = new Set(state.feeds.flatMap((f) => [hostOf(f.site_url), hostOf(f.feed_url)]).filter(Boolean));
  const items = r.items || [];
  box.innerHTML = `<h2>関連する記事${r.words?.length ? `<span class="words">「${esc(r.words.join(" "))}」で検索</span>` : ""}</h2>` +
    (items.length ? `<ul>${items.map((x) => `
      <li>
        <a class="rtitle" href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>
        <div class="rmeta">
          <span>${esc(x.source)}${x.published_at ? ` · ${relTime(x.published_at)}` : ""}</span>
          ${!x.sourceUrl ? "" : mine.has(hostOf(x.sourceUrl))
            ? `<span class="badge">登録済み</span>`
            : `<button class="link" data-add-site="${esc(x.sourceUrl)}">＋ このサイトを登録</button>`}
        </div>
      </li>`).join("")}</ul>`
      : `<p class="muted">${esc(r.error || "見つかりませんでした")}</p>`);
}

// 関連記事の配信元サイトを、いつもの追加画面で登録する（RSS の自動検出もそのまま使う）
function addSite(url) {
  openAddDialog();
  $("#add-url").value = url;
  $("#add-form").requestSubmit();
}

function renderReaderBar() {
  const a = state.current;
  if (!a) return;
  $("#r-star").textContent = a.is_starred ? "★" : "☆";
  $("#r-star").classList.toggle("on", a.is_starred);
  $("#r-read").textContent = a.is_read ? "未読にする" : "既読にする";
  $("#r-open").href = a.link || "#";
}

function closeReader() {
  $("#app").classList.remove("reading");
}

// ---------- 既読・お気に入り ----------
async function setRead(a, val) {
  if (a.is_read === val) return;
  a.is_read = val;
  state.counts[a.feed_id] = Math.max(0, (state.counts[a.feed_id] || 0) + (val ? -1 : 1));
  updateItem(a);
  renderNav();
  const { error } = await sb.from("articles").update({ is_read: val }).eq("id", a.id);
  if (error) toast("保存に失敗しました");
}

async function toggleStar(a) {
  a.is_starred = !a.is_starred;
  updateItem(a);
  const { error } = await sb.from("articles").update({ is_starred: a.is_starred }).eq("id", a.id);
  if (error) toast("保存に失敗しました");
}

async function markAllRead() {
  if (!confirm(`「${viewTitle()}」の記事をすべて既読にしますか？`)) return;
  let q = sb.from("articles").update({ is_read: true }).eq("is_read", false);
  q = viewFilter(q);
  const { error } = await q;
  if (error) return toast("失敗しました");
  await loadSidebar();
  for (const a of state.articles) a.is_read = true;
  document.querySelectorAll(".item").forEach((li) => li.classList.add("read"));
  renderReaderBar();
}

// ---------- 更新（全フィード再取得） ----------
function setStatus(html) { $("#status").innerHTML = html; }

function idleStatus(errors = state.lastErrors || []) {
  const t = store.get("lastRefresh", null);
  let s = t ? `最終更新 ${new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` : "";
  if (errors.length) s += `　<span class="err-link" id="err-link">${errors.length}件のフィードで取得エラー</span>`;
  setStatus(s);
}

function refreshFeeds() {
  if (state.refreshing) return state.refreshing;
  if (!state.feeds.length) { idleStatus(); return Promise.resolve(); }
  setStatus("更新中…");
  state.refreshing = (async () => {
    try {
      const r = await callFn({ action: "refresh" });
      store.set("lastRefresh", Date.now());
      state.lastErrors = r.errors || [];
      const cur = state.current;
      await loadSidebar();
      if (r.added) {
        await loadList(true);
        if (cur) document.querySelector(`.item[data-id="${cur.id}"]`)?.classList.add("active");
      }
      toast(r.added ? `新着 ${r.added} 件` : "新着はありません");
    } catch (e) {
      toast("更新に失敗しました: " + e.message);
    } finally {
      state.refreshing = null;
      idleStatus();
    }
  })();
  return state.refreshing;
}

// スマホ: 一覧を下に引っぱって更新
function bindPullToRefresh() {
  const scroller = $("#list-scroll"), ptr = $("#ptr");
  let startY = null, dist = 0;
  const TRIGGER = 64;
  scroller.addEventListener("touchstart", (e) => {
    startY = scroller.scrollTop <= 0 && !state.refreshing ? e.touches[0].clientY : null;
    dist = 0;
  }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || scroller.scrollTop > 0) { dist = 0; ptr.style.height = "0px"; return; }
    e.preventDefault();
    dist = Math.min(dy * 0.5, 100);
    ptr.classList.remove("anim");
    ptr.style.height = dist + "px";
    ptr.classList.toggle("ready", dist >= TRIGGER);
    ptr.querySelector(".ptr-text").textContent = dist >= TRIGGER ? "離すと更新" : "引っぱって更新";
  }, { passive: false });
  scroller.addEventListener("touchend", async () => {
    if (startY == null) return;
    startY = null;
    ptr.classList.add("anim");
    if (dist >= TRIGGER) {
      ptr.style.height = "44px";
      ptr.classList.remove("ready");
      ptr.classList.add("loading");
      ptr.querySelector(".ptr-icon").textContent = "↻";
      ptr.querySelector(".ptr-text").textContent = "更新中…";
      await refreshFeeds();
      ptr.classList.remove("loading");
      ptr.querySelector(".ptr-icon").textContent = "↓";
    }
    ptr.style.height = "0px";
    dist = 0;
  });
}

// ---------- フィード・フォルダの管理 ----------
function folderOptions(sel, selected, withNew) {
  sel.innerHTML = `<option value="">（フォルダなし）</option>` +
    state.folders.map((f) => `<option value="${f.id}"${f.id === selected ? " selected" : ""}>${esc(f.name)}</option>`).join("") +
    (withNew ? `<option value="__new">＋ 新しいフォルダ…</option>` : "");
}

function openAddDialog() {
  const v = state.view;
  folderOptions($("#add-folder"), v.type === "folder" ? v.id : v.type === "feed" ? feedById(v.id)?.folder_id : null, true);
  $("#add-url").value = "";
  $("#add-newfolder").value = "";
  $("#add-newfolder-wrap").hidden = true;
  setMsg("#add-msg", "");
  resetCandidates();
  $("#add-submit").disabled = false;
  closeDrawer();
  $("#add-dialog").showModal();
  $("#add-url").focus();
}

function setMsg(sel, text, error) {
  const el = $(sel);
  el.textContent = text;
  el.classList.toggle("error", !!error);
}

// 追加ダイアログ：1回目の送信で候補を探し、複数・非公式なら選んでもらってから登録する
let addCandidates = null;

function resetCandidates() {
  addCandidates = null;
  $("#add-candidates").hidden = true;
  $("#add-candidates").innerHTML = "";
  $("#add-submit").textContent = "追加";
}

function renderCandidates(list) {
  const box = $("#add-candidates");
  const many = list.length > 1;
  const firstNew = list.findIndex((c) => !c.registered);
  box.innerHTML = `<p class="lead">${many ? `${list.length}件のフィードが見つかりました。登録するものを選んでください。` : "このフィードが見つかりました。"}</p>` +
    list.map((c, i) => `<label class="cand${c.registered ? " done" : ""}">
      <input type="checkbox" value="${esc(c.feedUrl)}"${c.registered ? " disabled" : i === firstNew ? " checked" : ""}>
      <span>
        <span class="ctitle">${esc(c.title)}</span>${c.registered ? `<span class="badge">登録済み</span>` : ""}${c.unofficial ? `<span class="badge">非公式</span>` : ""}
        <div class="csub">${c.count}件${c.newest ? ` · 最新 ${relTime(c.newest)}` : ""}${c.unofficial ? ` · ${esc(c.unofficial)} が作成` : ""}</div>
        <div class="csub">${esc(c.feedUrl)}</div>
      </span></label>`).join("");
  box.hidden = false;
  $("#add-submit").textContent = "選んだフィードを登録";
}

async function submitAdd(e) {
  e.preventDefault();
  const url = $("#add-url").value.trim();
  if (!url) return;
  $("#add-submit").disabled = true;
  try {
    if (!addCandidates) {
      setMsg("#add-msg", "フィードを探しています…");
      const { candidates } = await callFn({ action: "discover", url });
      const c = candidates[0];
      if (candidates.length === 1 && c.registered) throw new Error(`「${c.title}」はすでに登録されています`);
      if (candidates.length === 1 && !c.unofficial) return await addFeeds([c.feedUrl]);
      addCandidates = candidates;
      renderCandidates(candidates);
      setMsg("#add-msg", candidates.some((x) => x.unofficial)
        ? "「非公式」はサイト運営者ではない第三者が作っているフィードです。将来止まる可能性があります。" : "");
      $("#add-submit").disabled = false;
      return;
    }
    const picked = [...$("#add-candidates").querySelectorAll("input:checked")].map((i) => i.value);
    if (!picked.length) throw new Error("登録するフィードを選んでください");
    await addFeeds(picked);
  } catch (err) {
    setMsg("#add-msg", err.message, true);
    $("#add-submit").disabled = false;
  }
}

async function addFeeds(feedUrls) {
  let folderId = $("#add-folder").value || null;
  if (folderId === "__new") {
    const name = $("#add-newfolder").value.trim();
    if (!name) throw new Error("フォルダ名を入力してください");
    const { data, error } = await sb.from("folders").insert({ name }).select().single();
    if (error) throw error;
    folderId = data.id;
    // 失敗して再送信しても二重に作らない
    await loadSidebar();
    folderOptions($("#add-folder"), folderId, true);
  }
  setMsg("#add-msg", "登録しています…");
  const r = await callFn({ action: "add", feeds: feedUrls, folder_id: folderId });
  $("#add-dialog").close();
  const names = r.feeds.length === 1 ? `「${r.feeds[0].title}」` : `${r.feeds.length}件のフィード`;
  toast(`${names}を登録しました（記事${r.added}件）${r.skipped.length ? `・${r.skipped.length}件はスキップ` : ""}`);
  state.view = r.feeds.length > 1 && folderId ? { type: "folder", id: folderId } : { type: "feed", id: r.feeds[0].id };
  store.set("view", state.view);
  await loadSidebar();
  await loadList(true);
  renderRelated();  // 関連記事の「＋ 登録」を「登録済み」に変える
}

let editingFeed = null, editingFolder = null;

function openFeedDialog(id) {
  editingFeed = feedById(id);
  if (!editingFeed) return;
  $("#feed-title").value = editingFeed.title;
  folderOptions($("#feed-folder"), editingFeed.folder_id, false);
  $("#feed-url").textContent = editingFeed.feed_url;
  setMsg("#feed-err", editingFeed.last_error ? "前回の取得エラー: " + editingFeed.last_error : "", true);
  $("#feed-dialog").showModal();
}

async function saveFeed(e) {
  e.preventDefault();
  const { error } = await sb.from("feeds").update({
    title: $("#feed-title").value.trim() || editingFeed.title,
    folder_id: $("#feed-folder").value || null,
  }).eq("id", editingFeed.id);
  if (error) return setMsg("#feed-err", "保存に失敗しました", true);
  $("#feed-dialog").close();
  await loadSidebar();
  if (["folder", "all"].includes(state.view.type)) loadList(true);
}

async function deleteFeed() {
  if (!confirm(`「${editingFeed.title}」を削除しますか？\nこのフィードの記事（お気に入りを含む）も消えます。`)) return;
  const { error } = await sb.from("feeds").delete().eq("id", editingFeed.id);
  if (error) return toast("削除に失敗しました");
  $("#feed-dialog").close();
  if (state.view.type === "feed" && state.view.id === editingFeed.id) state.view = { type: "all" };
  await loadSidebar();
  loadList(true);
}

function openFolderDialog(id) {
  editingFolder = id ? state.folders.find((f) => f.id === id) : null;
  $("#folder-dlg-title").textContent = editingFolder ? "フォルダの設定" : "新しいフォルダ";
  $("#folder-name").value = editingFolder?.name || "";
  $("#folder-delete").hidden = !editingFolder;
  closeDrawer();
  $("#folder-dialog").showModal();
  $("#folder-name").focus();
}

async function saveFolder(e) {
  e.preventDefault();
  const name = $("#folder-name").value.trim();
  if (!name) return;
  const { error } = editingFolder
    ? await sb.from("folders").update({ name }).eq("id", editingFolder.id)
    : await sb.from("folders").insert({ name });
  if (error) return toast("保存に失敗しました");
  $("#folder-dialog").close();
  loadSidebar();
}

async function deleteFolder() {
  if (!confirm(`フォルダ「${editingFolder.name}」を削除しますか？\n中のフィードは「フォルダなし」に移ります。`)) return;
  const { error } = await sb.from("folders").delete().eq("id", editingFolder.id);
  if (error) return toast("削除に失敗しました");
  $("#folder-dialog").close();
  if (state.view.type === "folder" && state.view.id === editingFolder.id) state.view = { type: "all" };
  await loadSidebar();
  loadList(true);
}

// ---------- 画面操作 ----------
function selectView(key) {
  const [type, id] = key.split(":");
  state.view = id ? { type, id } : { type };
  store.set("view", state.view);
  renderNav();
  closeDrawer();
  loadList(true);
}

const closeDrawer = () => $("#app").classList.remove("drawer");

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

function bindUI() {
  $("#nav").addEventListener("click", (e) => {
    const t = e.target;
    if (t.dataset.editFeed) return openFeedDialog(t.dataset.editFeed);
    if (t.dataset.editFolder) return openFolderDialog(t.dataset.editFolder);
    if (t.dataset.toggle) {
      const id = t.dataset.toggle;
      state.closed.has(id) ? state.closed.delete(id) : state.closed.add(id);
      store.set("closedFolders", [...state.closed]);
      return renderNav();
    }
    const item = t.closest("[data-nav]");
    if (item) selectView(item.dataset.nav);
  });

  $("#list").addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) return toggleStar(state.articles.find((a) => a.id === star.dataset.star));
    const li = e.target.closest(".item");
    if (li) openArticle(li.dataset.id);
  });

  $("#list-scroll").addEventListener("scroll", (e) => {
    const s = e.currentTarget;
    if (s.scrollTop + s.clientHeight > s.scrollHeight - 400) loadList(false);
  });

  $("#digest-head").addEventListener("click", (e) => {
    if (e.target.id === "digest-make") makeDigest(e.target);
  });

  $("#unread-only").onchange = (e) => {
    state.unreadOnly = e.target.checked;
    store.set("unreadOnly", state.unreadOnly);
    loadList(true);
  };
  $("#mark-all-btn").onclick = markAllRead;
  $("#menu-btn").onclick = () => $("#app").classList.add("drawer");
  $("#backdrop").onclick = closeDrawer;
  $("#reader-back").onclick = () => history.back();
  window.addEventListener("popstate", closeReader);

  $("#reader-body").addEventListener("click", (e) => {
    const site = e.target.closest("[data-add-site]");
    if (site) addSite(site.dataset.addSite);
  });

  $("#r-star").onclick = () => state.current && toggleStar(state.current);
  $("#r-read").onclick = () => state.current && setRead(state.current, !state.current.is_read);

  $("#add-feed-btn").onclick = openAddDialog;
  $("#add-form").onsubmit = submitAdd;
  $("#add-url").oninput = () => { if (addCandidates) { resetCandidates(); setMsg("#add-msg", ""); } };
  $("#add-folder").onchange = (e) => {
    $("#add-newfolder-wrap").hidden = e.target.value !== "__new";
    if (e.target.value === "__new") $("#add-newfolder").focus();
  };
  $("#feed-form").onsubmit = saveFeed;
  $("#feed-delete").onclick = deleteFeed;
  $("#new-folder-btn").onclick = () => openFolderDialog(null);
  $("#folder-form").onsubmit = saveFolder;
  $("#folder-delete").onclick = deleteFolder;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

  $("#status").addEventListener("click", (e) => {
    if (e.target.id === "err-link") alert(state.lastErrors.join("\n"));
  });

  $("#logout-btn").onclick = async () => {
    await sb.auth.signOut();
    location.reload();
  };

  // PC用キーボード操作: j/k 次/前, m 既読切替, s お気に入り, v 元記事
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = state.articles.indexOf(state.current);
    if (e.key === "j" || e.key === "k") {
      const next = state.articles[e.key === "j" ? i + 1 : Math.max(0, i - 1)];
      if (next) {
        openArticle(next.id);
        document.querySelector(`.item[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "j" && i > state.articles.length - 5) loadList(false);
    } else if (e.key === "m" && state.current) setRead(state.current, !state.current.is_read);
    else if (e.key === "s" && state.current) toggleStar(state.current);
    else if (e.key === "v" && state.current?.link) window.open(state.current.link, "_blank", "noopener");
  });

  bindPullToRefresh();
}

init();
