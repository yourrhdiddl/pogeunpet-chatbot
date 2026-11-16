// 포근펫 챗봇 서버 (Firebase Cloud Functions, 서울 리전)
//  /api/chat    AI 상담: 서버가 상담 규칙 + 상품·재고 데이터 + 운영자 피드백 지침을 붙여 Claude에 물어봄
//  /api/lookup  주문·운송장 조회: 주문자 이름을 가린 결과만 돌려줌 (고객은 주문 데이터를 직접 읽을 수 없음)
//  /api/health  상태 확인
// Claude API 키는 Firebase 비밀 저장소(Secret Manager)의 ANTHROPIC_API_KEY에 보관
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { RULES } = require("./prompt");

admin.initializeApp();
const db = admin.firestore();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const MODEL = "claude-opus-5-5";

/* ---------- 남용 막기: IP별 1분당 요청 수 제한 (인스턴스 메모리 기준) ---------- */
const hits = new Map();
function tooMany(req, kind, perMin) {
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "?").split(",")[0].trim();
  const key = kind + ":" + ip, now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 60000);
  list.push(now); hits.set(key, list);
  return list.length > perMin;
}

/* ---------- 도구 ---------- */
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const won = (n) => (Number(n) || 0).toLocaleString("ko-KR") + "원";
const maskName = (s = "") => s.length <= 1 ? s : s.length === 2 ? s[0] + "*" : s[0] + "*".repeat(s.length - 2) + s[s.length - 1];
const toMap = (snap) => Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));

// 상품·재고만 AI에게 전달 (주문·배송·고객 정보는 넘기지 않음)
async function storeContext() {
  const [p, inv] = await Promise.all([db.collection("products").get(), db.collection("inventory").get()]);
  const products = toMap(p), inventory = toMap(inv);
  const lines = Object.entries(products).sort(([a], [b]) => a.localeCompare(b)).map(([id, x]) => {
    const i = inventory[id] || {};
    const stock = Number(i.stock);
    return `${id} | ${x.name} | ${x.category} | ${won(x.price)} | 재고 ${Number.isFinite(stock) ? stock : "?"}개${stock === 0 ? ` 입고예정 ${i.restockDate || "미정"}` : ""} | 태그 ${x.tags || ""} | ${x.description || ""}`;
  });
  return `[상품·재고]\n${lines.join("\n")}\n\n[주문·배송]\n주문 내역은 이 대화에 없다. 주문이나 배송을 물으면 주문번호(예: ORD-1003)나 운송장 번호를 보내 달라고 안내한다. 보내 주면 화면에서 바로 조회된다.`;
}

// 관리자 피드백 → 운영자 지침 (최근 30개, 오래된 것부터 번호)
async function guidance() {
  const list = (await db.collection("feedback").get()).docs.map((d) => d.data());
  const rules = list.filter((f) => f.useAsRule && String(f.note || "").trim())
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-30);
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

/* ---------- /api/chat ---------- */
async function chat(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { type: "method", message: "POST만 받아요." } });
  if (tooMany(req, "chat", 15)) return res.status(429).json({ error: { type: "rate_limited", message: "질문이 너무 많아요. 1분 뒤에 다시 보내 주세요." } });
  const key = ANTHROPIC_API_KEY.value();
  if (!key) return res.status(500).json({ error: { type: "no_key", message: "서버에 API 키가 설정되지 않았어요." } });
  const messages = (Array.isArray(req.body?.messages) ? req.body.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
    .slice(-12).map((m) => ({ role: m.role, content: String(m.content).slice(0, 1500) }));
  while (messages[0]?.role === "assistant") messages.shift();
  if (!messages.length || messages.at(-1).role !== "user") return res.status(400).json({ error: { type: "no_messages", message: "보낼 질문이 없어요." } });

  const [ctx, g] = await Promise.all([storeContext(), guidance()]);
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
      max_tokens: 2048,
      stream: true,
      output_config: { effort: "low" },   // 상담 채팅은 빠른 답이 중요
      fallbacks: "default",                // 모델이 거절하면 서버 측에서 다른 모델로 이어서 답함
      system: RULES + "\n\n" + ctx + g.text,   // 규칙·데이터·지침은 서버가 만듦 (브라우저가 보낸 지시는 쓰지 않음)
      messages,
    }),
  });
  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    console.error("anthropic error", upstream.status, err?.error?.type);
    return res.status(upstream.status === 429 ? 429 : 502).json({ error: { type: "api", message: "AI 연결이 잠시 원활하지 않아요. 다시 보내 주세요." } });
  }
  res.status(200).set({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-guides-count": String(g.count) });
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

/* ---------- /api/lookup ---------- */
async function lookup(req, res) {
  if (tooMany(req, "lookup", 30)) return res.status(429).json({ error: { type: "rate_limited", message: "조회가 너무 많아요. 잠시 후 다시 해 주세요." } });
  const orderId = String(req.query.order || "").toUpperCase();
  const tracking = String(req.query.tracking || "").replace(/[^0-9]/g, "");
  let order = null, orderDocId = null, ship = null;
  if (/^ORD-\d{4}$/.test(orderId)) {
    const o = await db.doc(`orders/${orderId}`).get();
    if (o.exists) { order = o.data(); orderDocId = o.id; }
    const s = await db.collection("shipments").where("orderId", "==", orderId).limit(1).get();
    if (!s.empty) ship = { id: s.docs[0].id, ...s.docs[0].data() };
  } else if (/^\d{10,14}$/.test(tracking)) {
    const s = await db.collection("shipments").where("trackingNo", "==", tracking).limit(1).get();
    if (!s.empty) ship = { id: s.docs[0].id, ...s.docs[0].data() };
  } else {
    return res.status(400).json({ error: { type: "bad_query", message: "주문번호나 운송장 번호 형식이 아니에요." } });
  }
  if (!order && !ship) return res.status(404).json({ error: { type: "not_found" } });
  // 주문자 이름은 가리고, 휴대폰 뒷자리는 보내지 않음
  const safeOrder = order && { id: orderDocId, status: order.status, orderedAt: order.orderedAt, total: order.total, items: order.items, customer: maskName(order.customer || "") };
  res.set("cache-control", "no-store").json({ order: safeOrder, shipment: ship });
}

/* ---------- 라우터 ---------- */
exports.api = onRequest(
  { region: "asia-northeast3", secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "256MiB", maxInstances: 3 },
  async (req, res) => {
    try {
      const p = req.path.replace(/\/+$/, "");
      if (p === "/api/chat") return await chat(req, res);
      if (p === "/api/lookup") return await lookup(req, res);
      if (p === "/api/health") return res.json({ ok: true, firebase: true, model: MODEL });
      return res.status(404).json({ error: { type: "not_found", message: "없는 API예요: " + p } });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: { type: "server", message: "서버 오류가 났어요." } });
      else res.end();
    }
  }
);
