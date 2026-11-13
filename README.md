# RSSリーダー

PC・スマホで使える、アカウントごとのRSSリーダー。すべて無料枠で動きます。

- 画面: GitHub Pages（`index.html` / `app.js` / `style.css`）
- ログイン・データ保存: Supabase（Googleログイン + Postgres、行レベルセキュリティで自分のデータだけ見える）
- 記事の取得: Supabase Edge Function `feeds`（`supabase/functions/feeds/`）

## 機能
- サイトのURLを入れると RSS/Atom のURLを自動検出して登録（`<link rel="alternate">` → ページ内のRSSリンク → よくあるパスの順に探す）
- フォルダ分け、フィード名の変更・移動・削除
- アプリ内で記事を読む / 元記事を開く / 既読・未読の切り替え / お気に入り / 表示中をすべて既読
- 更新: PCはページを開く・リロードするたび、スマホは一覧を下に引っぱると全フィードを再取得
- キーボード（PC）: `j`/`k` 次/前の記事, `m` 既読切替, `s` お気に入り, `v` 元記事
- 既読でお気に入りでない記事は60日で自動削除（無料枠の容量対策）

## セットアップ

### 1. Supabase プロジェクトを作る
1. https://supabase.com で無料アカウント作成 → New project（Region は Tokyo）
2. 左メニュー **SQL Editor** に `supabase/migrations/0001_init.sql` の中身を貼って Run
3. 続けて `supabase/migrations/0002_allowlist.sql` も貼って Run（ログインできる人を限定する）
4. SQL Editor で、使う人のGmailを許可リストに追加（アドレスはリポジトリに書かない）
   ```sql
   insert into private.allowed_emails (email) values ('自分@gmail.com'), ('夫@gmail.com');
   ```
5. **Project Settings → API Keys** の Publishable key（古い画面では anon public）と Project URL を `config.js` に書く

### 2. Edge Function をデプロイ
```sh
cd rss-reader
npx supabase login
npx supabase functions deploy feeds --project-ref <プロジェクトID> --no-verify-jwt
```
（プロジェクトIDは Project URL の `https://<ここ>.supabase.co` の部分）

### 3. Googleログインを設定
1. https://console.cloud.google.com → 新しいプロジェクト → **APIとサービス → OAuth同意画面** を作成（外部・アプリ名とメールだけでOK）
2. **認証情報 → 認証情報を作成 → OAuthクライアントID**（種類: ウェブアプリケーション）
   - 承認済みのリダイレクトURI: `https://<プロジェクトID>.supabase.co/auth/v1/callback`
3. Supabase **Authentication → Sign In / Providers → Google** を有効にし、クライアントIDとシークレットを貼る
4. Supabase **Authentication → URL Configuration**
   - Site URL: GitHub Pages のURL（例 `https://<ユーザー名>.github.io/rss-reader/`）
   - Redirect URLs に同じURLと `http://localhost:8000/` を追加

### 4. 公開
GitHub にリポジトリを作って push → Settings → Pages → Branch `main` / root。

ローカル確認: `python3 -m http.server 8000` → http://localhost:8000/

## 注意
- 許可リストにないGoogleアカウントは登録できません。人を増やすときは上の insert を実行するだけです。
- Supabase 無料枠は 1週間アクセスがないとプロジェクトが一時停止します（ダッシュボードから再開可能）。
- フィード検出のテスト: `npm i && node scripts/test-feed.js https://zenn.dev/`
