-- 毎朝の自動実行（管理者の鍵 = service_role）に、必要な操作だけを許可する
grant usage on schema public to service_role;
grant select on public.folders to service_role;                    -- フォルダ名を読む
grant select, update on public.feeds to service_role;              -- フィード一覧を読み、取得日時・エラーを書く
grant select, insert, delete on public.articles to service_role;   -- 新着を追加し、古い既読記事を消す
grant select, insert on public.digests to service_role;            -- 回数を数え、ダイジェストを保存する
