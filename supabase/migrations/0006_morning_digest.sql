-- 毎朝 6:50（日本時間）にフィード更新とダイジェスト作成を自動で行う
-- 事前に、合言葉を Vault（名前: cron_secret）と Edge Function のシークレット（CRON_SECRET）の両方に登録しておく

-- 定期実行から呼ぶときは誰もログインしていないので、対象ユーザーを引数で受け取れるようにする
-- （ログインしているときは auth.uid() が優先されるので、他人の id を渡しても自分の分しか見えない）
drop function if exists public.digest_candidates(int);

create function public.digest_candidates(per_folder int default 300, for_user uuid default null)
returns table (id uuid, folder_id uuid, folder_name text, folder_unread bigint, feed_title text, title text, head text)
language sql stable security invoker as $$
  select id, folder_id, folder_name, folder_unread, feed_title, title, head from (
    select a.id, f.folder_id, coalesce(fo.name, 'フォルダなし') as folder_name,
      count(*) over (partition by f.folder_id) as folder_unread,
      row_number() over (partition by f.folder_id order by a.published_at desc) as rn,
      f.title as feed_title, a.title, left(a.content, 1500) as head
    from public.articles a
      join public.feeds f on f.id = a.feed_id
      left join public.folders fo on fo.id = f.folder_id
    where a.user_id = coalesce(auth.uid(), for_user) and not a.is_read
  ) t
  where rn <= least(per_folder, 300)
$$;
revoke execute on function public.digest_candidates(int, uuid) from public, anon;
grant execute on function public.digest_candidates(int, uuid) to authenticated, service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- 21:50 UTC = 6:50 JST。フィードを登録しているユーザーごとに1回ずつ Edge Function を呼ぶ
select cron.schedule('morning-digest', '50 21 * * *', $$
  select net.http_post(
    url := 'https://xhlaqedydttpnhnydlrx.supabase.co/functions/v1/feeds',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := jsonb_build_object('action', 'morning', 'user_id', u.user_id),
    timeout_milliseconds := 10000)
  from (select distinct user_id from public.feeds) u
$$);
