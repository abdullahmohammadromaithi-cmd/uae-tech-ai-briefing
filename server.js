const express = require("express");
const cron    = require("node-cron");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

let briefing  = null;
let isRunning = false;
let lastRunAt = null;
let lastError = null;
let runLog    = [];

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/api/status", (req, res) => {
  res.json({ ok: true, isRunning, lastRunAt, lastError, hasBriefing: !!briefing, apiKeySet: !!process.env.ANTHROPIC_API_KEY });
});

app.get("/api/briefing", (req, res) => {
  if (!briefing) return res.status(404).json({ error: "No briefing yet. Click Run Now." });
  res.json(briefing);
});

app.get("/api/log", (req, res) => {
  res.json({ log: runLog.slice(-100) });
});

app.post("/api/run", async (req, res) => {
  if (isRunning) return res.status(409).json({ error: "Already running. Please wait." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set." });
  res.json({ ok: true, message: "Started. Takes 2-3 minutes." });
  run();
});

cron.schedule("0 3 * * *", () => {
  if (!isRunning && process.env.ANTHROPIC_API_KEY) run();
});

async function run() {
  isRunning = true;
  lastError = null;
  runLog    = [];
  log("Pipeline started");
  try {
    const key = process.env.ANTHROPIC_API_KEY;

    log("Step 1: Searching for UAE tech and AI news...");
    const newsRaw = await claude(key, true,
      "Search the web for the 15 most important UAE technology and AI news stories from the last 7 days.\n\n" +
      "Include:\n" +
      "- UAE AI strategy and government announcements\n" +
      "- Companies: G42, e&, Presight, Careem, Noon, du, Etisalat\n" +
      "- Initiatives: Smart Dubai, ADNOC AI, Hub71, GITEX, MBZUAI\n" +
      "- Global AI news relevant to UAE\n" +
      "- GCC tech investment and startup news\n\n" +
      "Return a JSON array. Each object must have:\n" +
      "  title, source, date (YYYY-MM-DD), url, summary (3-4 sentences), category (uae_ai | uae_tech | global_ai | gcc_tech | policy)\n\n" +
      "Return ONLY the JSON array. No markdown. No extra text."
    );

    log("Parsing articles...");
    const articles = parseList(newsRaw);
    log("Found " + articles.length + " articles");

    log("Step 2: Generating analysis...");
    const analysisRaw = await claude(key, false,
      "You are a UAE technology analyst. Based on these articles produce a briefing.\n\n" +
      "ARTICLES:\n" + JSON.stringify(articles, null, 2) + "\n\n" +
      "Return a JSON object with EXACTLY these keys:\n" +
      "{\n" +
      '  "headline": "one punchy sentence summarising the biggest story",\n' +
      '  "summary": "3-4 sentence executive overview",\n' +
      '  "top_stories": [ { "title": "...", "why_it_matters": "2 sentences" } ],\n' +
      '  "trends": [ { "trend": "...", "detail": "2-3 sentences", "uae_angle": "..." } ],\n' +
      '  "opportunities": [ { "title": "...", "problem": "...", "approach": "...", "who": "...", "action": "first step this week" } ],\n' +
      '  "global_watch": "2-3 sentences on global AI UAE should monitor",\n' +
      '  "sentiment": "bullish | cautious | mixed | neutral"\n' +
      "}\n\n" +
      "Return ONLY the JSON object. No markdown. No extra text."
    );

    log("Parsing analysis...");
    const analysis = parseObj(analysisRaw);

    briefing  = { date: new Date().toISOString().slice(0, 10), generatedAt: new Date().toISOString(), articles, analysis };
    lastRunAt = new Date().toISOString();
    log("Done! " + articles.length + " articles. Briefing ready.");
  } catch (err) {
    lastError = err.message;
    log("ERROR: " + err.message);
    console.error(err);
  } finally {
    isRunning = false;
  }
}

async function claude(apiKey, useSearch, prompt) {
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages:   [{ role: "user", content: prompt }],
  };
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error("Claude API " + res.status + ": " + await res.text());
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

function parseList(raw) {
  try {
    let t = raw.trim();
    if (t.startsWith("```")) { t = t.split("\n").slice(1).join("\n").replace(/```\s*$/, "").trim(); }
    const p = JSON.parse(t);
    if (Array.isArray(p)) return p;
    for (const v of Object.values(p)) { if (Array.isArray(v)) return v; }
  } catch (_) {}
  return [];
}

function parseObj(raw) {
  try {
    let t = raw.trim();
    if (t.startsWith("```")) { t = t.split("\n").slice(1).join("\n").replace(/```\s*$/, "").trim(); }
    return JSON.parse(t);
  } catch (_) {
    return { headline: "", summary: raw, top_stories: [], trends: [], opportunities: [], global_watch: "", sentiment: "neutral" };
  }
}

function log(msg) {
  const entry = "[" + new Date().toISOString().slice(11, 19) + "] " + msg;
  runLog.push(entry);
  console.log(entry);
}

app.listen(PORT, () => {
  console.log("Running on port " + PORT);
  console.log("API key set: " + !!process.env.ANTHROPIC_API_KEY);
});
