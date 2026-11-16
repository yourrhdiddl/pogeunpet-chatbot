// 포근펫 챗봇 로컬 서버 (설치할 것 없음, Node만 있으면 됨)
// 실행: node serve.cjs  →  http://localhost:5500 접속 (Node 18 이상)
//
// 하는 일
//  1) 챗봇·실습 페이지 같은 정적 파일 제공
//  2) 관리자 피드백 저장   → data/feedback.json (어느 브라우저에서 열어도 같은 피드백을 씀)
//  3) AI 상담 중계        → 서버가 '운영자 피드백 지침'을 붙여서 Claude API에 보냄
//     API 키: 환경변수 ANTHROPIC_API_KEY가 있으면 그것을, 없으면 브라우저 관리자 화면에 저장된 키를 씀
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 5500;
const ROOT = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const FB_FILE = path.join(DATA_DIR, "feedback.json");
const MODEL = "claude-opus-5-5";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".pdf": "application/pdf" };

/* ---------- 피드백 저장소 (JSON 파일) ---------- */
function readFeedback() {
  try { const v = JSON.parse(fs.readFileSync(FB_FILE, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeFeedback(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FB_FILE);   // 쓰다가 꺼져도 파일이 깨지지 않게 임시 파일 → 교체
}
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const activeRules = (list) => list.filter((f) => f.useAsRule && String(f.note || "").trim());

// 관리자 피드백 → AI에게 붙이는 '운영자 피드백 지침' (최근 30개, 오래된 것부터 번호)
function buildGuidance(list) {
  const rules = activeRules(list).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-30);
  if (!rules.length) return { text: "", count: 0 };
  const text = "\n\n[운영자 피드백 지침]\n관리자가 이전 상담 답변을 검토하고 남긴 지침이다. 위 규칙과 함께 반드시 지킨다. 지침끼리 부딪히면 번호가 큰(더 최근) 지침을 따른다.\n" +
    rules.map((f, i) => {
      let line = `${i + 1}. ${clip(f.note, 300)}`;
      if (f.question) {
        line += ` (상황: 고객이 "${clip(f.question, 80)}"라고 물었을 때`;
        if (f.rating === "bad") line += `. 그때의 답변 "${clip(f.answer, 120)}"은 고쳐야 할 답변이었음`;
        if (f.rating === "good") line += `. 그때의 답변이 좋았음`;
        line += ")";
      }
      return line;
    }).join("\n");
  return { text, count: rules.length };
}

/* ---------- 공통 도구 ---------- */
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}
const FB_FIELDS = ["id", "sessionId", "msgId", "question", "answer", "kind", "rating", "note", "useAsRule", "createdAt", "updatedAt"];
function cleanEntry(e) {
  const out = {};
  for (const k of FB_FIELDS) if (e[k] !== undefined) out[k] = e[k];
  out.id = String(out.id || "F" + Date.now().toString(36)).slice(0, 64);
  out.note = String(out.note || "").slice(0, 2000);
  out.question = String(out.question || "").slice(0, 2000);
  out.answer = String(out.answer || "").slice(0, 4000);
  out.rating = out.rating === "good" || out.rating === "bad" ? out.rating : null;
  out.useAsRule = !!out.useAsRule;
  return out;
}

/* ---------- API ---------- */
async function handleApi(req, res, p) {
  // 상태 확인: 페이지가 '서버 모드'로 동작할지 결정하는 데 씀
  if (p === "/api/health" && req.method === "GET") {
    const list = readFeedback();
    return sendJson(res, 200, { ok: true, serverKey: !!process.env.ANTHROPIC_API_KEY, model: MODEL, feedback: list.length, guides: activeRules(list).length, file: "data/feedback.json" });
  }
  // 피드백 목록 / 저장(같은 id면 덮어씀) / 삭제
  if (p === "/api/feedback" && req.method === "GET") return sendJson(res, 200, readFeedback());
  if (p === "/api/feedback" && req.method === "POST") {
    const body = await readBody(req);
    const items = Array.isArray(body) ? body : [body];
    const list = readFeedback();
    const now = new Date().toISOString();
    for (const raw of items) {
      const e = cleanEntry(raw);
      const i = list.findIndex((f) => f.id === e.id);
      if (i >= 0) list[i] = { ...list[i], ...e, updatedAt: raw.updatedAt || now };
      else list.push({ createdAt: now, updatedAt: now, ...e });
    }
    writeFeedback(list);
    return sendJson(res, 200, list);
  }
  const del = p.match(/^\/api\/feedback\/([A-Za-z0-9_-]{1,64})$/);
  if (del && req.method === "DELETE") {
    const list = readFeedback().filter((f) => f.id !== del[1]);
    writeFeedback(list);
    return sendJson(res, 200, list);
  }
  // 지금 AI에게 붙는 지침 미리보기
  if (p === "/api/guidance" && req.method === "GET") return sendJson(res, 200, buildGuidance(readFeedback()));

  // AI 상담 중계: 페이지가 보낸 규칙+상점 데이터에 서버가 지침을 붙여 Claude에 보내고, 답을 스트리밍으로 돌려줌
  if (p === "/api/chat" && req.method === "POST") {
    const key = process.env.ANTHROPIC_API_KEY || String(req.headers["x-api-key"] || "");
    if (!key) return sendJson(res, 401, { error: { type: "no_key", message: "API 키가 없어요. 관리자 화면에 키를 넣거나 서버에 ANTHROPIC_API_KEY를 설정해 주세요." } });
    const body = await readBody(req);
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
      .slice(-12).map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
    while (messages[0]?.role === "assistant") messages.shift();
    if (!messages.length) return sendJson(res, 400, { error: { type: "no_messages", message: "보낼 질문이 없어요." } });
    const guidance = buildGuidance(readFeedback());
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2026-10-21",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        stream: true,
        output_config: { effort: "low" },   // 상담 채팅은 빠른 답이 중요
        fallbacks: "default",                // 모델이 거절하면 서버 측에서 다른 모델로 이어서 답함
        system: String(body.system || "").slice(0, 200000) + guidance.text,
        messages,
      }),
    });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      return sendJson(res, upstream.status, err);
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-guides-count": String(guidance.count), "access-control-expose-headers": "x-guides-count" });
    for await (const chunk of upstream.body) res.write(chunk);
    return res.end();
  }
  return sendJson(res, 404, { error: { type: "not_found", message: "없는 API예요: " + p } });
}

/* ---------- 서버 ---------- */
http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (p.startsWith("/api/")) {
    try { return await handleApi(req, res, p); }
    catch (e) { console.error(e); if (!res.headersSent) return sendJson(res, 500, { error: { type: "server", message: String(e.message || e) } }); return res.end(); }
  }
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || file.startsWith(DATA_DIR)) { res.writeHead(403); return res.end("forbidden"); }   // 폴더 밖 파일·데이터 폴더 차단
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("파일을 찾을 수 없어요: " + p); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`포근펫 챗봇: http://localhost:${PORT}`);
  console.log(`탭 실습:     http://localhost:${PORT}/tabs.html`);
  console.log(`흐름도:      http://localhost:${PORT}/flowcharts.html`);
  console.log(`피드백 저장: ${FB_FILE}`);
  console.log(`API 키:      ${process.env.ANTHROPIC_API_KEY ? "서버 환경변수 사용" : "브라우저 관리자 화면의 키 사용"}`);
});
