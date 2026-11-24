-- 今朝のダイジェスト（AIが選んだおすすめ記事）

create table public.digests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  summary text not null,
  picks jsonb not null,            -- [{ "article_id": "...", "reason": "..." }]
  article_count int not null,      -- AIに渡した記事の数
  input_tokens int not null,       -- 費用の確認用
  output_tokens int not null,
  created_at timestamptz not null default now()
);
create index digests_user_created on public.digests (user_id, created_at desc);

alter table public.digests enable row level security;
create policy "own digests" on public.digests
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 削除・変更は許可しない（消して1日の回数制限をすり抜けられないように）
grant select, insert on public.digests to authenticated;

-- AIに渡す未読記事（新しい順）。本文は先頭だけ切り出して転送量を減らす
create function public.digest_candidates(max_count int default 300)
returns table (id uuid, feed_title text, title text, head text)
language sql stable security invoker as $$
  select a.id, f.title, a.title, left(a.content, 1500)
  from public.articles a join public.feeds f on f.id = a.feed_id
  where a.user_id = auth.uid() and not a.is_read
  order by a.published_at desc
  limit least(max_count, 300)
$$;
revoke execute on function public.digest_candidates(int) from public, anon;
grant execute on function public.digest_candidates(int) to authenticated;
