// ステップ2：Claude API を1回だけ呼んでみる
// 実行: node --env-file=.env scripts/ai-hello.js
import Anthropic from "@anthropic-ai/sdk";

// 引数なしで作ると、環境変数 ANTHROPIC_API_KEY を自動で読む
const client = new Anthropic();

const msg = await client.messages.create({
  model: "claude-haiku-5-5",   // 使うモデル
  max_tokens: 500,             // 返事の長さの上限（＝料金の上限）
  messages: [
    { role: "user", content: "RSSリーダーとは何か、小学生にもわかるように2文で説明して" },
  ],
});

console.log(msg.content);  // AIの返事
console.log(msg.usage);    // 使ったトークン数
