-- RSSリーダー：テーブルと行レベルセキュリティ（各ユーザーは自分のデータだけ見える）

create table public.folders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.feeds (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  folder_id  uuid references public.folders on delete set null,
  title      text not null,
  site_url   text,
  feed_url   text not null,
  last_error text,
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, feed_url)
);

create table public.articles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  feed_id      uuid not null references public.feeds on delete cascade,
  guid         text not null,
  title        text not null,
  link         text,
  author       text,
  content      text,
  image        text,
  published_at timestamptz not null default now(),
  is_read      boolean not null default false,
  is_starred   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (feed_id, guid)
);

create index articles_user_published on public.articles (user_id, published_at desc);
create index articles_feed_published on public.articles (feed_id, published_at desc);
create index articles_unread on public.articles (user_id, feed_id) where not is_read;

alter table public.folders  enable row level security;
alter table public.feeds    enable row level security;
alter table public.articles enable row level security;

create policy "own folders"  on public.folders  for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own feeds"    on public.feeds    for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own articles" on public.articles for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 「新しいテーブルを自動で公開」がオフでも使えるよう、ログイン済みユーザーにだけ明示的に許可
-- （どの行に触れるかは上のポリシーで本人の分だけに絞られる）
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.folders, public.feeds, public.articles to authenticated;

-- フィードごとの未読数
create function public.unread_counts()
returns table (feed_id uuid, unread bigint)
language sql stable security invoker
as $$
  select feed_id, count(*) from public.articles
  where user_id = auth.uid() and not is_read
  group by feed_id
$$;

revoke execute on function public.unread_counts() from public, anon;
grant execute on function public.unread_counts() to authenticated;
