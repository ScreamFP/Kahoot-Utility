const fs = require("node:fs");
const path = require("node:path");
const Kahoot = require("kahoot.js-updated");

const pin = String(process.env.KAHOOT_PIN || "").trim();
const name = String(process.env.KAHOOT_NAME || "github-monitor").trim().slice(0, 20);
const waitSeconds = Math.max(30, Number(process.env.WAIT_SECONDS || 600));
const groqApiKey = process.env.GROQ_API_KEY;
const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const logDir = path.resolve("artifacts");
const logFile = path.join(logDir, "kahoot-events.ndjson");

if (!/^\d{4,10}$/.test(pin)) {
  console.error("KAHOOT_PIN must contain 4-10 digits.");
  process.exit(1);
}
if (!name) {
  console.error("KAHOOT_NAME must not be empty.");
  process.exit(1);
}

fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(logFile, "", "utf8");

function record(type, data) {
  const entry = { at: new Date().toISOString(), type, data };
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
  console.log(`[${entry.at}] ${type}`);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

function toPlain(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => toPlain(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "function") continue;
    result[key] = toPlain(item, depth + 1);
  }
  return result;
}

function questionToJson(question) {
  const plain = toPlain(question);
  return {
    questionIndex: plain?.questionIndex ?? plain?.index,
    type: plain?.type,
    question: plain?.question ?? plain?.text,
    choices: plain?.choices ?? plain?.answers,
    raw: plain,
  };
}

async function analyzeWithGroq(question) {
  if (!groqApiKey) {
    record("groq_skipped", { reason: "GROQ_API_KEY is not configured" });
    return;
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: groqModel,
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: "あなたはKahoot問題の分析補助です。問題文と選択肢を読み、正解候補と理由を日本語で簡潔に説明してください。回答の自動送信はしません。",
        },
        {
          role: "user",
          content: JSON.stringify(question),
        },
      ],
    }),
  });

  const body = await response.json();
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${JSON.stringify(body)}`);
  record("groq_analysis", body.choices?.[0]?.message?.content || body);
}

async function main() {
  record("runner_start", { pin, name, waitSeconds, groq: Boolean(groqApiKey), groqModel });

  const client = new Kahoot();
  let joined = false;
  let questionCount = 0;

  client.on("Joined", settings => {
    joined = true;
    record("joined", settings);
  });
  client.on("QuizStart", data => record("quiz_start", toPlain(data)));
  client.on("QuestionStart", async question => {
    questionCount += 1;
    const normalized = questionToJson(question);
    record("question", normalized);
    try {
      await analyzeWithGroq(normalized);
    } catch (error) {
      record("groq_error", { message: error.message });
    }
  });
  client.on("QuizEnd", data => record("quiz_end", toPlain(data)));
  client.on("Disconnect", reason => record("disconnect", reason));
  client.on("error", error => record("client_error", { message: error?.message || String(error) }));

  const joinPromise = client.join(pin, name);
  await Promise.race([
    joinPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Join timeout")), 30000)),
  ]);

  if (!joined) record("joined_event_not_seen", { note: "join promise resolved" });
  record("waiting_for_questions", { seconds: waitSeconds });
  await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
  record("runner_end", { questionCount });
  try { client.leave(); } catch { /* already disconnected */ }
}

main().catch(error => {
  record("fatal_error", { message: error.message, stack: error.stack });
  process.exitCode = 1;
});
