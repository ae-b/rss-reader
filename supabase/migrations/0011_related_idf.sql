-- 関連記事: 珍しい単語ほど重く数える（IDF）。ありふれた単語だけの一致では関連とみなさない
drop function if exists public.related_articles(uuid, int, int, uuid);

create function public.related_articles(p_id uuid, max_count int default 5, min_score real default 0, for_user uuid default null)
returns table (id uuid, feed_id uuid, title text, link text, author text, image text,
               published_at timestamptz, is_read boolean, is_starred boolean,
               score real, matched text[])
language plpgsql stable security invoker
set search_path = public, extensions
as $$
declare
  uid uuid := coalesce(auth.uid(), for_user);  -- ログイン中は本人。SQL Editor で試すときだけ for_user を使う
  src text;
  total int;
  terms text[];
  weights real[];
  query text;
begin
  select left(a.search_text, length(a.title) + 100) into src from public.articles a where a.id = p_id and a.user_id = uid;
  if src is null then return; end if;
  select count(*) into total from public.articles a where a.user_id = uid;

  -- ① 索引と同じ設定（中身のある名詞だけ）で単語に区切る。1文字の語や、記号だけの語は除く
  select array_agg(distinct x.t) into terms
  from jsonb_array_elements(extensions.pgroonga_command('tokenize', array['tokenizer',
         'TokenMecab("target_class", "-名詞/非自立", "target_class", "-名詞/数", "target_class", "-名詞/接尾", "target_class", "-名詞/代名詞", "target_class", "-名詞/副詞可能", "target_class", "名詞")',
         'string', src])::jsonb -> 1) e,
       lateral (select e ->> 'value' as t) x
  where char_length(x.t) >= 2 and x.t ~ '[0-9A-Za-zぁ-んァ-ヶー一-龠]';
  if terms is null then return; end if;

  -- ② 単語ごとの重み = log(全記事数 / その単語を含む記事数)。珍しい単語ほど大きい
  select array_agg(t), array_agg(w) into terms, weights from (
    select t, ln(total::real / greatest(1, (
      select count(*) from public.articles a
      where a.user_id = uid and position(lower(t) in lower(a.search_text)) > 0)))::real as w
    from unnest(terms) t
  ) x where w > 0;
  if terms is null then return; end if;

  -- ③ どれかの単語を含む記事を索引で探し、一致した単語の重みの合計で並べる
  select string_agg('"' || replace(replace(t, '\', '\\'), '"', '\"') || '"', ' OR ') into query from unnest(terms) t;
  return query
    select a.id, a.feed_id, a.title, a.link, a.author, a.image, a.published_at, a.is_read, a.is_starred,
           m.s, m.hit
    from public.articles a,
         lateral (select sum(k.w)::real as s, array_agg(k.t || '(' || round(k.w::numeric, 1) || ')' order by k.w desc) as hit
                  from unnest(terms, weights) as k(t, w)
                  where position(lower(k.t) in lower(a.search_text)) > 0) m
    where a.search_text operator(extensions.&@~) query
      and a.id <> p_id and a.user_id = uid
      and m.s >= min_score
    order by m.s desc, a.published_at desc
    limit least(max_count, 20);
end
$$;
revoke execute on function public.related_articles(uuid, int, real, uuid) from public, anon;
grant execute on function public.related_articles(uuid, int, real, uuid) to authenticated;
