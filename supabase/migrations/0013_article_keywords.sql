-- 関連記事を Google ニュースで探すための手がかり: 記事から「珍しい名詞」を重い順に取り出す
-- （登録フィード内の関連記事 related_articles は使わなくなったので削除する）
drop function if exists public.related_articles(uuid, int, real, uuid);

create function public.article_keywords(p_id uuid, max_terms int default 3, for_user uuid default null)
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
  -- タイトルに出てくる単語を優先し、その中で重い順に max_terms 語
  select array_agg(t order by in_title desc, w desc) into result from (
    select x.t,
           position(lower(x.t) in lower(t_title)) > 0 as in_title,
           ln(total::real / greatest(1, (select count(*) from public.articles a
             where a.user_id = uid and position(lower(x.t) in lower(a.search_text)) > 0))) as w
    from (select distinct e ->> 'value' as t
          from jsonb_array_elements(extensions.pgroonga_command('tokenize', array['tokenizer',
            'TokenMecab("target_class", "-名詞/非自立", "target_class", "-名詞/数", "target_class", "-名詞/接尾", "target_class", "-名詞/代名詞", "target_class", "-名詞/副詞可能", "target_class", "名詞")',
            'string', src])::jsonb -> 1) e) x
    where char_length(x.t) >= 2 and x.t ~ '[0-9A-Za-zぁ-んァ-ヶー一-龠]'
    order by in_title desc, w desc
    limit greatest(1, least(max_terms, 5))
  ) k where w > 0;
  return result;
end
$$;
revoke execute on function public.article_keywords(uuid, int, uuid) from public, anon;
grant execute on function public.article_keywords(uuid, int, uuid) to authenticated;
