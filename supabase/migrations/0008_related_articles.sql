-- 関連記事: PGroonga（日本語対応の全文検索）で、内容の似ている記事を探す
create extension if not exists pgroonga with schema extensions;

-- ① 検索用の列: タイトル + タグを除いた本文の冒頭1000文字（記事が追加・更新されると自動で作り直される）
alter table public.articles add column search_text text generated always as (
  title || ' ' || left(regexp_replace(left(coalesce(content, ''), 5000), '<[^>]*>', ' ', 'g'), 1000)
) stored;

-- ② 索引: MeCab で日本語を単語に区切って作る
create index articles_search on public.articles
  using pgroonga (search_text) with (tokenizer = 'TokenMecab');

-- ③ 開いた記事に似ている記事を、似ている順に返す（RLS が効くので自分の記事だけ）
create function public.related_articles(p_id uuid, max_count int default 5)
returns table (id uuid, feed_id uuid, title text, link text, author text, image text,
               published_at timestamptz, is_read boolean, is_starred boolean, score double precision)
language plpgsql stable security invoker
set search_path = public, extensions
set enable_seqscan = off  -- &@* は索引を使うときしか動かないので、全件を順に読む方法を使わせない
as $$
declare q text;
begin
  select left(a.search_text, 400) into q from public.articles a where a.id = p_id;
  if q is null then return; end if;
  return query
    select a.id, a.feed_id, a.title, a.link, a.author, a.image, a.published_at, a.is_read, a.is_starred,
           extensions.pgroonga_score(a.tableoid, a.ctid)
    from public.articles a
    where a.search_text operator(extensions.&@*) q and a.id <> p_id and a.user_id = auth.uid()
    order by 10 desc
    limit least(max_count, 20);
end
$$;
revoke execute on function public.related_articles(uuid, int) from public, anon;
grant execute on function public.related_articles(uuid, int) to authenticated;
