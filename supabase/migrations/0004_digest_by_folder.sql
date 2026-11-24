-- ダイジェスト: 未読記事をフォルダごとに新しい順で取り出す（どのフォルダから何件使うかは Edge Function が決める）
drop function if exists public.digest_candidates(int);

create function public.digest_candidates(per_folder int default 300)
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
    where a.user_id = auth.uid() and not a.is_read
  ) t
  where rn <= least(per_folder, 300)
$$;
revoke execute on function public.digest_candidates(int) from public, anon;
grant execute on function public.digest_candidates(int) to authenticated;
