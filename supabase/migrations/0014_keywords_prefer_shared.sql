-- 検索の手がかり: その記事にしか出てこない単語（筆者独自の呼び名など）は後回しにする
create or replace function public.article_keywords(p_id uuid, max_terms int default 3, for_user uuid default null)
returns text[]
language plpgsql stable security invoker
set search_path = public, extensions
as $$
declare
  uid uuid := coalesce(auth.uid(), for_user);  -- ログイン中は本人。SQL Editor で試すときだけ for_user を使う
  t_title text;
  src text;
  total int;
  result text[];
begin
  select a.title, left(a.search_text, length(a.title) + 100) into t_title, src
  from public.articles a where a.id = p_id and a.user_id = uid;
  if src is null then return null; end if;
  select count(*) into total from public.articles a where a.user_id = uid;

  -- 中身のある名詞に区切り、珍しさ（log(全記事数 / 含む記事数)）で重みを付ける
  -- 並べ方: ① タイトルに出てくる単語 ② ほかの記事にも出てくる単語（その記事だけの呼び名は検索に向かない） ③ 重い順
  select array_agg(t order by in_title desc, elsewhere desc, w desc) into result from (
    select t, in_title, df > 1 as elsewhere, ln(total::real / greatest(1, df)) as w from (
      select x.t,
             position(lower(x.t) in lower(t_title)) > 0 as in_title,
             (select count(*) from public.articles a
               where a.user_id = uid and position(lower(x.t) in lower(a.search_text)) > 0) as df
      from (select distinct e ->> 'value' as t
            from jsonb_array_elements(extensions.pgroonga_command('tokenize', array['tokenizer',
              'TokenMecab("target_class", "-名詞/非自立", "target_class", "-名詞/数", "target_class", "-名詞/接尾", "target_class", "-名詞/代名詞", "target_class", "-名詞/副詞可能", "target_class", "名詞")',
              'string', src])::jsonb -> 1) e) x
      where char_length(x.t) >= 2 and x.t ~ '[0-9A-Za-zぁ-んァ-ヶー一-龠]'
    ) d
    where df < total
    order by in_title desc, elsewhere desc, w desc
    limit greatest(1, least(max_terms, 5))
  ) k;
  return result;
end
$$;
