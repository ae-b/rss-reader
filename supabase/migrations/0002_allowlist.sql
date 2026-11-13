-- 登録できるアカウントを許可リストのメールアドレスに限定する
-- private スキーマは API に公開されないので、リストの中身はブラウザから読めない
-- メールアドレス自体はこのファイルに書かず、SQL Editor で直接追加する:
--   insert into private.allowed_emails (email) values ('you@gmail.com');

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.allowed_emails (
  email text primary key
);

create function private.check_allowed_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from private.allowed_emails where lower(email) = lower(new.email)
  ) then
    raise exception 'not_allowed';
  end if;
  return new;
end;
$$;

create trigger only_allowed_emails
  before insert on auth.users
  for each row execute function private.check_allowed_email();
