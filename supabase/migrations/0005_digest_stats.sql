-- ダイジェストのフォルダごとの記録（未読数・AIに渡した数・指定本数・AIが返した数・採用した数）
alter table public.digests add column stats jsonb;
