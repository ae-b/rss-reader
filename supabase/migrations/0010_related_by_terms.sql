-- 関連記事: 手がかりの名詞を自分で取り出し、「共通する名詞の数」で並べる方式に変える
-- （&@* は内部で手がかりを自動で選ぶため、結果の理由が分からず調整できなかった）
drop function if exists public.related_articles(uuid, int);

create function public.related_articles(p_id uuid, max_count int default 5, min_match int default 2, for_user uuid default null)
returns table (id uuid, feed_id uuid, title text, link text, author text, image text,
               published_at timestamptz, is_read boolean, is_starred boolean,
               score int, matched text[])
language plpgsql stable security invoker
set search_path = public, extensions
as $$
declare
  uid uuid := coalesce(auth.uid(), for_user);  -- ログイン中は本人。SQL Editor で試すときだけ for_user を使う
  src text;
  terms text[];
  query text;
begin
  select left(a.search_text, length(a.title) + 100) into src from public.articles a where a.id = p_id and a.user_id = uid;
  if src is null then return; end if;

  -- ① 索引と同じ設定（中身のある名詞だけ）で単語に区切る。1文字の語は弱いので除く
  select array_agg(distinct t) into terms
  from jsonb_array_elements(extensions.pgroonga_command('tokenize', array['tokenizer',
         'TokenMecab("target_class", "-名詞/非自立", "target_class", "-名詞/数", "target_class", "-名詞/接尾", "target_class", "-名詞/代名詞", "target_class", "-名詞/副詞可能", "target_class", "名詞")',
         'string', src])::jsonb -> 1) e,
       lateral (select e ->> 'value' as t) x
  where char_length(t) >= 2;
  if terms is null then return; end if;

  -- ② どれかの単語を含む記事を索引で探す（"語1" OR "語2" …）
  select string_agg('"' || replace(replace(t, '\', '\\'), '"', '\"') || '"', ' OR ') into query from unnest(terms) t;

  -- ③ 共通する単語の数を数え、多い順に並べる。少なすぎるものは関連が薄いので出さない
  return query
    select a.id, a.feed_id, a.title, a.link, a.author, a.image, a.published_at, a.is_read, a.is_starred,
           cardinality(m.hit)::int, m.hit
    from public.articles a,
         lateral (select array_agg(t) as hit from unnest(terms) t
                  where position(lower(t) in lower(a.search_text)) > 0) m
    where a.search_text operator(extensions.&@~) query
      and a.id <> p_id and a.user_id = uid
      and cardinality(m.hit) >= min_match
    order by cardinality(m.hit) desc, a.published_at desc
    limit least(max_count, 20);
end
$$;
revoke execute on function public.related_articles(uuid, int, int, uuid) from public, anon;
grant execute on function public.related_articles(uuid, int, int, uuid) to authenticated;
