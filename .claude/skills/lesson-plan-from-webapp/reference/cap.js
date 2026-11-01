// 지도안용 화면 캡처: 실제 수업 화면(t.html, 교사 화면)을 가짜 Firebase 와 시연 데이터로 열어 단계별로 찍는다.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const seed = require("./seed.js");
const ROOT = path.resolve(__dirname, "../../public");
const OUT = path.join(__dirname, "shots");
const DEMO = JSON.parse(fs.readFileSync(path.join(ROOT, "demo/data/jeju2018.json"), "utf8"));

const stubs = {
  "firebase-app.js": `export const initializeApp = () => ({});`,
  "firebase-auth.js": `
    let cur = window.__user || null; let notify = () => {};
    const auth = { get currentUser() { return cur; }, authStateReady: async () => {} };
    export const getAuth = () => auth;
    export const setPersistence = async () => {};
    export const browserSessionPersistence = {};
    export const onAuthStateChanged = (a, cb) => { notify = cb; setTimeout(() => cb(cur), 0); window.__setUser = (u) => { cur = u; cb(u); }; };
    export const signInAnonymously = async () => { cur = { uid: window.__anonUid || "anon1", isAnonymous: true }; notify(cur); };
    export const signOut = async () => { cur = null; };
    export class GoogleAuthProvider {}
    export const signInWithPopup = async () => {};
    export const signInWithEmailAndPassword = async () => {};
    export const createUserWithEmailAndPassword = async () => ({});
    export const signInWithRedirect = async () => {};
    export const getRedirectResult = async () => null;`,
  "firebase-firestore.js": `
    const isDoc = (p) => p.split("/").length % 2 === 0;
    export const getFirestore = () => ({}); export const initializeFirestore = () => ({});
    export const doc = (_d, p) => ({ p }); export const collection = (_d, p) => ({ p });
    export const query = (c) => c; export const where = () => 0; export const orderBy = () => 0;
    export const serverTimestamp = () => 0; export const deleteField = () => ({ del: 1 });
    export const getDoc = async (r) => (window.__docs[r.p] ? { exists: () => true, data: () => window.__docs[r.p] } : { exists: () => false });
    export const getDocFromServer = async (r) => (window.__docs[r.p] ? { exists: () => true, data: () => window.__docs[r.p] } : { exists: () => false });
    export const getDocs = async (r) => ({ docs: (window.__cols[r.p] || []).map((d) => ({ id: d.id, data: () => d })) });
    export const updateDoc = async (r, data) => { window.__writes.push(data); };
    const subs = (window.__subs = window.__subs || {});
    const docSnap = (p) => ({ exists: () => p in window.__docs, data: () => window.__docs[p] || {} });
    window.__push = (p, data) => { window.__docs[p] = data; (subs[p] || []).forEach((cb) => cb(docSnap(p))); };
    export const onSnapshot = (r, cb) => {
      (subs[r.p] = subs[r.p] || []).push(cb);
      setTimeout(() => (isDoc(r.p) ? cb(docSnap(r.p)) : cb({ docs: (window.__cols[r.p] || []).map((d) => ({ id: d.id, data: () => d })) })), 0);
      return () => {};
    };`,
  "firebase-functions.js": `
    export const getFunctions = () => ({});
    export const httpsCallable = (_f, name) => async (data) => ({ data: await window.__fn(name, data) });`,
};

const types = { ".webp": "image/webp", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const FONTS = path.join(__dirname, "fonts/node_modules");
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u.startsWith("/__f/")) { const f = path.join(FONTS, u.slice(5)); if (!f.startsWith(FONTS) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": f.endsWith(".woff2") ? "font/woff2" : "font/woff", "Access-Control-Allow-Origin": "*" }); return res.end(fs.readFileSync(f)); }
  const f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[path.extname(f)] || "text/html; charset=utf-8" });
  res.end(fs.readFileSync(f));
});

const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DEEP = Object.fromEntries(["beliefs", "premise", "causeMap", "sources", "tradeoff", "chain", "power", "why"].map((k) => [k, true]));
const stamp = (i) => ({ toMillis: () => 1700000000000 + i * 60000, toDate: () => new Date(1700000000000 + i * 60000) });

async function main() {
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const only = process.argv.slice(2);
  const want = (n) => !only.length || only.includes(n);

  // ---------- 학생(태블릿 가로) ----------
  const me = { id: "j_applicant", name: "아델", letter: DEMO.letters[0].letter, personal: true };
  const caseData = { ...DEMO, me, say: undefined };
  const ctx = await browser.newContext({ userAgent: IPAD, viewport: { width: 820, height: 780 }, deviceScaleFactor: 2, hasTouch: true, locale: "ko-KR" });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ contentType: "text/javascript", body: stubs[r.request().url().split("/").pop()] || "" }));
  await pg.route(/cdn\.jsdelivr/, (r) => r.fulfill({ contentType: "text/css", body: `@font-face{font-family:'Pretendard Variable';font-weight:45 920;font-style:normal;font-display:swap;src:url(${base}/__f/pretendard/dist/web/variable/woff2/PretendardVariable.woff2) format('woff2-variations');}` }));
  await pg.route(/fonts\.googleapis/, (r) => r.fulfill({ contentType: "text/css", body: fs.readFileSync(path.join(FONTS, "@fontsource/gowun-batang/400.css"), "utf8").replace(/url\(\.\/files\//g, `url(${base}/__f/@fontsource/gowun-batang/files/`) }));
  await pg.route(/fonts\.gstatic/, (r) => r.abort());
  await pg.addInitScript(({ work, logs, chat, picks, session, caseData, memberExtra }) => {
    try { localStorage.setItem("eps_help_ABC234_g1_가람", JSON.stringify(["1-pick", "1-chat", "1-note", "1-group", "2", "3", "4", "5", "6", "7"])); for (const k of ["teacher-main", "teacher-class", "demo-menu", "demo-play"]) localStorage.setItem("eps_tour_" + k, "1"); } catch {}
    window.__user = null; window.__anonUid = "anonX";
    const st = (i) => ({ toMillis: () => 1700000000000 + i * 60000, toDate: () => new Date(1700000000000 + i * 60000) });
    window.__docs = {
      "sessions/ABC234": session,
      "sessions/ABC234/members/anonX": { groupId: "g1", nickname: "가람", ...memberExtra },
      "sessions/ABC234/groups/g1": { work, picks, memberCount: 4, names: {}, aiCount: 9 },
    };
    window.__cols = {
      "sessions/ABC234/members/anonX/chat": chat.map((c, i) => ({ ...c, createdAt: st(i * 2) })),
      "sessions/ABC234/groups/g1/logs": logs.map((l, i) => ({ ...l, createdAt: st(100 + i) })),
    };
    window.__log = []; window.__writes = [];
    window.__fn = async (name, data) => {
      if (name === "joinSession") return { groupId: "g1", nickname: data.nickname, started: true, chatLimit: 5, level: "high", deep: session.deep, case: caseData };
      if (name === "getCase") return caseData;
      return {};
    };
  }, {
    work: seed.work, logs: seed.logs, chat: seed.chat, caseData,
    picks: { j_applicant: { uid: "anonX", nick: "가람" }, j_resident: { uid: "u2", nick: "나래" }, j_supporter: { uid: "u3", nick: "다온" }, j_officer: { uid: "u4", nick: "라온" } },
    session: { chatLimit: 5, level: "high", deep: DEEP, started: true, coach: true, title: "제주 예멘 난민 사건, 갈등 해결 방안 제안하기" },
    memberExtra: { chatCount: 4, stage: 1 },
  });
  await pg.goto(`${base}/t.html`);
  await pg.waitForSelector("#j-pw");
  await pg.fill("#j-code", "abc234"); await pg.fill("#j-group", "1"); await pg.fill("#j-nick", "가람"); await pg.fill("#j-pw", "pw1234");
  await pg.click("#j-btn");
  await pg.waitForSelector("#app:not(.hidden)");
  await pg.waitForTimeout(800);

  await pg.addStyleTag({ content: ".toast{display:none !important}" });
  const go = async (stage, sub) => { await pg.evaluate((n) => document.querySelector(`.stage-tab[data-stage="${n}"]`).click(), stage); if (sub) { await pg.evaluate((x) => document.querySelector(`.subnav [data-sub="${x}"]`).click(), sub); } await pg.waitForTimeout(700); };
  const card = (t) => pg.locator(`#panel .card:has(> h3:has-text("${t}")), #panel > h3.sec-h:has-text("${t}")`).first();
  const has = (t) => pg.locator(`#panel .card:has-text("${t}")`).first();
  const OFF = Number(process.env.OFF || 168);
  const view = async (name, loc, off = OFF) => { await loc.evaluate((el, o) => { const r = el.getBoundingClientRect(); window.scrollTo(0, r.top + scrollY - o); }, off); await pg.waitForTimeout(350); await pg.screenshot({ path: path.join(OUT, "v-" + name + ".jpg"), type: "jpeg", quality: 88 }); console.log("view", name); };
  await go(1, "pick"); await view("1-pick", card("누구와 이야기할까요"), 168);
  await go(1, "chat"); await pg.waitForTimeout(500); await view("1-chat", pg.locator(".chat-card").first(), 168);
  await go(1, "note"); await view("1-note", pg.locator("#panel .card").first(), 168);
  await go(1, "group"); await view("1-group", card("만난 사람들 나란히"), 168); await view("1-hmw", card("5) 우리 모둠의 문제"), 168);
  await go(2); await view("2-link", card("처음 내 생각 돌아보기"), 168); await view("2-cause", card("이 사건은 왜 생겼을까요"), 168); await view("2-check", card("확인할 질문 만들기"), 168); await view("2-mat", pg.locator("details.fold").first(), 168);
  await go(3); await view("3-ai", has("AI 검색 도우미의 답"), 168); await view("3-keep", card("우리 추측, 남길까 버릴까"), 168); await view("3-core", card("가장 큰 원인 정하기"), 168);
  await go(4); await view("4-cases", pg.locator("details.fold").first(), 168); await view("4-prop", card("우리 모둠 해결책 쓰기"), 168); await view("4-ai", has("AI 의견을 들은 해결책"), 168); await view("4-final", card("최종 해결책"), 168);
  await go(5); await view("5-pred", card("사람들은 어떻게 반응할까요"), 168); await view("5-scn", pg.locator("#panel .card:has-text('미래 이야기')").nth(1), 168);
  await go(6); await view("6-plan", card("무엇을 계획할까요"), 168);
  await go(7); await view("7-flow", card("우리 모둠의 흐름"), 168); await view("7-after", card("실제로는 어떻게 되었을까"), 168); await view("7-check", card("AI를 어떻게 썼는지 돌아보기"), 168);
  console.log("errors", errors);
  await browser.close(); srv.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
