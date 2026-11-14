// 記事ページを取得し、広告やメニューを除いた本文だけを抜き出す（Firefoxのリーダービューと同じ Readability）
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { fetchText } from "./feed.js";

const MAX_CHARS = 200_000;

// 本文が取れなければ null
export async function extractFullText(url) {
  const page = await fetchText(url, 10000);
  // 相対URLの画像・リンクを正しく直せるよう <base> を入れておく
  const html = page.text.replace(/<head([^>]*)>/i, `<head$1><base href="${page.url.replace(/"/g, "&quot;")}">`);
  const { document } = parseHTML(html);
  const article = new Readability(document, { charThreshold: 300 }).parse();
  if (!article?.content || (article.textContent || "").trim().length < 300) return null;
  return { content: article.content.slice(0, MAX_CHARS), textLength: article.textContent.trim().length };
}
