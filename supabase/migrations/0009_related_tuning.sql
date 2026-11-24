-- 関連記事の調整: 中身のある名詞だけで索引を作り、手がかりを「タイトル + 冒頭100文字」に絞る
drop index if exists public.articles_search;
create index articles_search on public.articles
  using pgroonga (search_text) with (tokenizer = 'TokenMecab(
    "target_class", "-名詞/非自立", "target_class", "-名詞/数", "target_class", "-名詞/接尾",
    "target_class", "-名詞/代名詞", "target_class", "-名詞/副詞可能", "target_class", "名詞")');

create or replace function public.related_articles(p_id uuid, max_count int default 5)
returns table (id uuid, feed_id uuid, title text, link text, author text, image text,
               published_at timestamptz, is_read boolean, is_starred boolean, score double precision)
language plpgsql stable security invoker
set search_path = public, extensions
set enable_seqscan = off  -- &@* は索引を使うときしか動かないので、全件を順に読む方法を使わせない
as $$
declare q text;
begin
  select left(a.search_text, length(a.title) + 100) into q from public.articles a where a.id = p_id;
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
