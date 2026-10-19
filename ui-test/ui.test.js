// 화면 테스트: public/ 을 정적 서버로 띄우고 Firebase 모듈(gstatic)을 가짜로 바꿔 학생·교사 화면의 동작을 확인한다.
// 서버 쪽 규칙·권한은 functions/test 와 rules-test 가 맡고, 여기서는 화면이 제대로 움직이는지만 본다.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "../public");
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
    export const signInWithEmailAndPassword = async (a, email) => { window.__pwLogin = email; };
    export const createUserWithEmailAndPassword = async (a, email) => {
      const user = { uid: "N1", email, isAnonymous: false, delete: async () => { window.__deleted = email; cur = null; notify(null); } };
      cur = user; notify(user); return { user };
    };
    export const signInWithRedirect = async () => {};`,
  "firebase-firestore.js": `
    const isDoc = (p) => p.split("/").length % 2 === 0;
    export const getFirestore = () => ({}); export const initializeFirestore = () => ({});
    export const doc = (_d, p) => ({ p }); export const collection = (_d, p) => ({ p });
    export const query = (c) => c; export const where = () => 0; export const orderBy = () => 0;
    export const serverTimestamp = () => 0; export const deleteField = () => ({ del: 1 });
    export const getDoc = async (r) => (window.__docs[r.p] ? { exists: () => true, data: () => window.__docs[r.p] } : { exists: () => false });
    export const getDocFromServer = async (r) => (window.__docs[r.p] ? { exists: () => true, data: () => window.__docs[r.p] } : { exists: () => false });
    export const getDocs = async (r) => ({ docs: (window.__cols[r.p] || []).map((d) => ({ id: d.id, data: () => d })) });
    export const updateDoc = async (r, data) => { window.__writes.push(data); if (window.__hangWrites) await new Promise(() => {}); };
    const subs = (window.__subs = window.__subs || {});
    const docSnap = (p) => ({ exists: () => p in window.__docs, data: () => window.__docs[p] || {} });
    // 테스트에서 서버가 값을 바꾼 것처럼 보여 줄 때 쓴다
    window.__push = (p, data) => { window.__docs[p] = data; (subs[p] || []).forEach((cb) => cb(docSnap(p))); };
    export const onSnapshot = (r, cb) => {
      (subs[r.p] = subs[r.p] || []).push(cb);
      setTimeout(() => (isDoc(r.p) ? cb(docSnap(r.p)) : cb({ docs: (window.__cols[r.p] || []).map((d) => ({ id: d.id, data: () => d })) })), 0);
      return () => {};
    };`,
  "firebase-functions.js": `
    export const getFunctions = () => ({});
    export const httpsCallable = (_f, name) => async (data) => { window.__log.push(name); return { data: await window.__fn(name, data) }; };`,
};

let srv, browser, base;
test.before(async () => {
  srv = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    const f = path.join(ROOT, u === "/" ? "index.html" : u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const types = { ".webp": "image/webp", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "text/html; charset=utf-8" });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => srv.listen(0, r));
  base = `http://localhost:${srv.address().port}`;
  const candidates = [process.env.PW_CHROMIUM, ...(fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium-")).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`) : []), undefined].filter((x) => x === undefined || fs.existsSync(x));
  for (const exe of candidates) { try { browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] }); break; } catch {} }
  assert.ok(browser, "chromium 을 찾을 수 없습니다 (npx playwright install chromium)");
});
test.after(async () => { await browser?.close(); srv?.close(); });

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
async function newPage(init, handler, arg, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true, ...ctxOpts });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  if (process.env.UI_DEBUG) { pg.on("pageerror", (e) => console.log("PAGEERROR", e.message)); pg.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text())); }
  await pg.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ contentType: "text/javascript", body: stubs[r.request().url().split("/").pop()] || "" }));
  await pg.route(/fonts\.(googleapis|gstatic)|cdn\.jsdelivr/, (r) => r.abort());
  await pg.addInitScript(init, arg);
  await pg.addInitScript(() => { window.__fn = (n, d) => window.__node(n, d); window.__log = []; window.__writes = []; });
  await pg.exposeFunction("__node", handler);
  return { pg, ctx, errors };
}

// ---------- 교사 ----------
function teacherFixture() {
  let cats = [
    { id: "timeline", title: "사건 흐름", type: "timeline", items: [{ id: "t1", kind: "사실", date: "2018. 4. 30.", text: "출도 제한 시행", caption: "A 2018" }, { id: "t2", kind: "사실", date: "6. 1.", text: "무사증 불허국 지정", caption: "B" }] },
    { id: "result", title: "심사 결과", type: "list", stats: [{ label: "심사 대상", value: "484명" }], items: [{ id: "r1", kind: "의견", text: "인권위 의견", caption: "C" }] },
  ];
  const st = { cats, isDefault: true, calls: [], overrides: {} };
  const persona = { id: "p1", axis: "당사자", name: "김씨", label: "예멘 출신 신청자", letter: ["안녕하세요"], voice: "조용함", habits: "음…", inner: "불안", story: ["a", "b"], episodes: ["c"], views: ["d"], claims: [], sources: [], limits: [] };
  st.handler = async (name, data) => {
    st.calls.push([name, data]);
    switch (name) {
      case "getMaterials": return { categories: JSON.parse(JSON.stringify(st.cats)), isDefault: st.isDefault };
      case "saveMaterials": st.cats = data.categories.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i })) })); st.isDefault = false; return { categories: st.cats, isDefault: false };
      case "resetMaterials": st.isDefault = true; return { categories: st.cats, isDefault: true };
      case "getCase": return { personas: [persona], materials: [], event: { teacherNote: "", background: [] } };
      case "getPersonaOverrides": return { overrides: st.overrides };
      case "savePersonaOverride": st.overrides = { ...st.overrides, [data.personaId]: { ...(st.overrides[data.personaId] || {}), ...data.fields } }; return { overrides: st.overrides };
      case "resetPersonaOverride": { const o = { ...st.overrides }; delete o[data.personaId]; st.overrides = o; return { overrides: o }; }
      case "healthCheck": await new Promise((r) => setTimeout(r, 3200)); return { firestore: { ok: true, ms: 40 }, models: [{ ok: true, ms: 900, model: "gpt-5-mini", reply: "ok" }, { ok: false, ms: 300, model: "gpt-5", error: "OpenAI 401" }], search: { ok: true, ms: 4000, found: true, sources: 2 }, config: { personas: 9, allowedDomains: 0, allowUnverified: false, webSearch: true } };
      default: return { ok: true, count: (data?.uids || []).length };
    }
  };
  return st;
}
async function openTeacher(st, { page = "teacher.html", ctxOpts, session = {} } = {}) {
  const t = await newPage((session) => {
    window.__user = { uid: "T1", email: "t@x.kr", isAnonymous: false };
    window.__docs = {};
    window.__cols = {
      sessions: [{ id: "ABC234", title: "테스트 수업", groupCount: 3, teacherUid: "T1", ...session }],
      "sessions/ABC234/members": [{ id: "u1", groupId: "g1", nickname: "가람", stage: 2, chatLocked: true, conduct: { total: 3, strikes: 3 } }, { id: "u2", groupId: "g1", nickname: "나래", stage: 2 }],
      "sessions/ABC234/alerts": [{ id: "a1", uid: "u1", nickname: "가람", groupId: "g1", category: "mockery", by: "rule", input: "놀리는 말", strikes: 3, locked: true }],
      "sessions/ABC234/groups": [{ id: "g1", name: "1모둠", work: {}, lastAiError: { stage: 3, message: "시간 초과" }, aiCount: 130, guardCount: 4 }, { id: "g2", name: "2모둠", work: {} }, { id: "g3", name: "3모둠", work: {} }],
    };
  }, st.handler, session, ctxOpts);
  await t.pg.goto(`${base}/${page}`);
  await t.pg.waitForSelector("#sessions button[data-code]");
  await t.pg.click("#sessions button[data-code]");
  await t.pg.waitForSelector("#students tr");
  return t;
}

test("교사용 계정 만들기: 이메일·비밀번호 + 인증 문구로 가입, 문구가 틀리면 만든 계정을 지우고, 승인 안 된 계정은 문구 입력 칸을 본다", async () => {
  const t = await newPage(() => { window.__user = null; window.__docs = {}; window.__cols = {}; }, async (name, data) => {
    if (name === "teacherStatus") return { teacher: false, signupOpen: true };
    if (name === "registerTeacher") { if (data.code !== "knue") throw new Error("permission-denied: 교사 인증 문구가 맞지 않습니다."); return { teacher: true }; }
    return {};
  });
  await t.pg.goto(`${base}/teacher.html`);
  await t.pg.click("#to-signup");
  await t.pg.locator("#su-form").waitFor({ state: "visible" });
  assert.ok(await t.pg.locator("#login").isHidden());
  await t.pg.fill("#su-email", "new@school.kr"); await t.pg.fill("#su-pass", "abcd1234"); await t.pg.fill("#su-pass2", "abcd1239"); await t.pg.fill("#su-code", "knue");
  await t.pg.click("#su-btn");
  await t.pg.waitForSelector(".toast");
  assert.ok(!(await t.pg.evaluate(() => window.__log.includes("registerTeacher"))), "비밀번호 확인이 다르면 만들지 않는다");
  // 문구가 틀리면 방금 만든 계정을 지우고 가입 화면에 남는다
  await t.pg.fill("#su-pass2", "abcd1234"); await t.pg.fill("#su-code", "wrong");
  await t.pg.click("#su-btn");
  await t.pg.waitForFunction(() => window.__deleted === "new@school.kr");
  assert.ok(await t.pg.locator("#su-form").isVisible());
  assert.ok(await t.pg.locator("#main").isHidden());
  // 맞으면 바로 교사 화면
  await t.pg.fill("#su-code", "knue");
  await t.pg.click("#su-btn");
  await t.pg.locator("#main").waitFor({ state: "visible" });
  assert.ok(await t.pg.locator("#signup").isHidden());
  assert.deepEqual(t.errors, []);
  await t.ctx.close();

  // 이미 로그인했지만 교사가 아닌 계정(처음 쓰는 구글 계정): 인증 문구 칸만 보인다
  const t2 = await newPage(() => { window.__user = { uid: "G9", email: "g@school.kr", isAnonymous: false }; window.__docs = {}; window.__cols = {}; }, async (name, data) => {
    if (name === "teacherStatus") return { teacher: false, signupOpen: true };
    if (name === "registerTeacher") return data.code === "knue" ? { teacher: true } : Promise.reject(new Error("x: 교사 인증 문구가 맞지 않습니다."));
    return {};
  });
  await t2.pg.goto(`${base}/teacher.html`);
  await t2.pg.locator("#su-approve").waitFor({ state: "visible" });
  assert.ok(await t2.pg.locator("#su-new").isHidden());
  assert.match(await t2.pg.textContent("#su-who"), /g@school\.kr/);
  assert.ok(await t2.pg.locator("#main").isHidden(), "교사로 승인되기 전에는 교사 화면을 보여 주지 않는다");
  await t2.pg.fill("#su-code2", "knue");
  await t2.pg.click("#su-approve-btn");
  await t2.pg.locator("#main").waitFor({ state: "visible" });
  assert.deepEqual(t2.errors, []);
  await t2.ctx.close();
});

test("교사: 로그인 화면에서 구글 말고 이메일·비밀번호(학교에서 받은 교사 계정)로도 로그인할 수 있다", async () => {
  const t = await newPage(() => { window.__user = null; window.__docs = {}; window.__cols = {}; }, async () => ({}));
  await t.pg.goto(`${base}/teacher.html`);
  await t.pg.waitForSelector("#pw-form");
  await t.pg.click("#pw-btn");
  await t.pg.waitForSelector(".toast");
  assert.equal(await t.pg.evaluate(() => window.__pwLogin), undefined, "빈 칸이면 로그인하지 않는다");
  await t.pg.fill("#pw-email", "teacher@knue.com"); await t.pg.fill("#pw-pass", "secret");
  await t.pg.click("#pw-btn");
  await t.pg.waitForFunction(() => window.__pwLogin === "teacher@knue.com");
  assert.equal(await t.pg.inputValue("#pw-pass"), "", "로그인 뒤 비밀번호 칸을 비운다");
  assert.deepEqual(t.errors, []);
  await t.ctx.close();
});

test("교사: 수업 목록 → 수업 열기 → 알림·학생 표", async () => {
  const st = teacherFixture(), { pg, errors } = await openTeacher(st);
  assert.ok(await pg.locator("#class-view").isVisible());
  assert.ok(!(await pg.locator("#class-list-view").isVisible()));
  await pg.waitForSelector("#alerts:not(.hidden)");
  const alerts = await pg.locator("#alerts-body").innerText();
  assert.match(alerts, /AI 오류/); assert.match(alerts, /130\/150/); assert.match(alerts, /감독자가 4번/);
  assert.match(await pg.locator("#students").innerText(), /비번 초기화/);
  assert.match(await pg.locator("#students").innerText(), /모둠 이동/);
  assert.deepEqual(errors, []);
});

test("교사: 학생 선택 → 일괄 비번 초기화(선택 수만큼 요청), 모둠 이동 요청", async () => {
  const st = teacherFixture(), { pg } = await openTeacher(st);
  assert.ok(await pg.locator("#bulk-reset").isDisabled());
  await pg.locator('[data-pick="u1"]').check();
  await pg.locator('[data-pick="u2"]').check();
  assert.match(await pg.locator("#bulk-n").innerText(), /2명 선택됨/);
  pg.once("dialog", (d) => d.accept());
  await pg.click("#bulk-reset");
  await pg.waitForFunction(() => window.__log.includes("resetStudentPassword"));
  assert.deepEqual(st.calls.find((c) => c[0] === "resetStudentPassword")[1].uids.sort(), ["u1", "u2"]);
  await pg.locator('[data-move="u1"]').click();
  assert.match(await pg.locator(".modal").innerText(), /가람 학생을 옮길 모둠/);
  assert.ok(await pg.locator('.modal .btn:has-text("1모둠")').isDisabled(), "지금 모둠은 고를 수 없다");
  await pg.locator('.modal .btn:has-text("2모둠")').click();
  await pg.waitForFunction(() => window.__log.includes("moveStudent"));
  assert.deepEqual(st.calls.find((c) => c[0] === "moveStudent")[1], { code: "ABC234", uid: "u1", groupNo: 2 });
});

test("교사: 자료 추가·수정·순서·삭제·분류 추가·되돌리기", async () => {
  const st = teacherFixture(), { pg } = await openTeacher(st);
  await pg.click('[data-ctab="materials"]');
  await pg.waitForSelector(".mcat");
  assert.equal(await pg.locator(".mcat").count(), 2);
  assert.match(await pg.locator("#mat-status").innerText(), /기본 자료/);
  await pg.locator(".mcat").first().locator("summary").click();
  const f = pg.locator('[data-form="new:timeline"]');
  await f.locator('[data-f="date"]').fill("6. 25."); await f.locator('[data-f="text"]').fill("심사 시작"); await f.locator('[data-f="caption"]').fill("연합뉴스");
  await f.locator('[data-m="item-add"]').click();
  await pg.waitForFunction(() => document.querySelectorAll(".mcat")[0].querySelectorAll(".mitem").length === 3);
  assert.equal(st.cats[0].items[2].text, "심사 시작");
  await pg.locator(".mcat").first().locator('[data-m="item-edit"]').first().click();
  const e = pg.locator('[data-form="edit:timeline:t1"]');
  await e.locator('[data-f="text"]').fill("수정됨"); await e.locator('[data-m="item-save"]').click();
  await pg.waitForFunction(() => document.body.innerText.includes("수정됨"));
  await pg.locator(".mcat").first().locator('[data-m="item-down"]').first().click();
  await pg.waitForFunction(() => document.querySelector(".mcat .mitem .mbody").innerText.includes("무사증"));
  pg.once("dialog", (d) => d.accept());
  await pg.locator(".mcat").first().locator('[data-m="item-del"]').first().click();
  await pg.waitForFunction(() => document.querySelectorAll(".mcat")[0].querySelectorAll(".mitem").length === 2);
  await pg.locator('[data-form="newcat"] [data-f="title"]').fill("전문가 의견");
  await pg.locator('[data-m="cat-add"]').click();
  await pg.waitForFunction(() => document.querySelectorAll(".mcat").length === 3);
  pg.once("dialog", (d) => d.accept());
  await pg.click('[data-m="reset"]');
  await pg.waitForFunction(() => document.querySelector("#mat-status").innerText.includes("기본 자료"));
});

test("교사: 인물 편집 → 저장·되돌리기 요청", async () => {
  const st = teacherFixture(), { pg } = await openTeacher(st);
  await pg.click('[data-ctab="personas"]');
  await pg.waitForSelector("#persona-edit details");
  await pg.locator("#persona-edit summary").click();
  await pg.locator('[data-pf="voice"]').fill("아주 느리게");
  await pg.locator('[data-pf="story"]').fill("첫째\n\n둘째");
  await pg.locator('[data-pe="save"]').click();
  await pg.waitForFunction(() => document.querySelector("#persona-edit").innerText.includes("항목 고침"));
  const sent = st.calls.find((c) => c[0] === "savePersonaOverride")[1];
  assert.equal(sent.fields.voice, "아주 느리게");
  assert.deepEqual(sent.fields.story, ["첫째", "둘째"]);
  assert.equal(sent.fields.claims, undefined, "사실 항목은 화면에서 보내지 않는다");
  pg.once("dialog", (d) => d.accept());
  await pg.locator('[data-pe="reset"]').click();
  await pg.waitForFunction(() => !document.querySelector("#persona-edit").innerText.includes("항목 고침"));
});

test("교사: 연결 점검 — 기다리는 동안 움직이는 표시와 초가 보이고, 끝나면 결과(정상·실패)가 보인다", async () => {
  const st = teacherFixture(), { pg } = await openTeacher(st);
  await pg.click("#tabs [data-tab='check']");
  await pg.click("#health-btn");
  await pg.waitForSelector("#health-out .wait");
  assert.ok(await pg.locator("#health-out .wait-anim .ring").isVisible());
  await pg.waitForFunction(() => Number(document.querySelector("#health-out .wait-sec")?.textContent) >= 1, null, { timeout: 4000 });
  await pg.waitForSelector("#health-out .group");
  const out = await pg.locator("#health-out").innerText();
  assert.match(out, /Firestore/); assert.match(out, /gpt-5-mini/); assert.match(out, /OpenAI 401/); assert.match(out, /출처 2개/);
});

// ---------- 학생 ----------
function studentFixture() {
  const st = { joined: [], chatCalls: [], releaseChat: null, failNext: false, calls: [], caseExtra: {} };
  st.handler = async (name, data) => {
    st.calls.push(name);
    const caseData = () => ({ title: "제목", summary: "요약", stakeholders: [],
      letters: [{ id: "p1", name: "김씨", brief: "예멘에서 온 20대 청년", letter: ["안녕하세요"], required: true, personal: true }, { id: "p2", name: "이씨", brief: "제주시 식당 주인", letter: ["식당을 합니다"], required: false, personal: true }, { id: "p3", name: "박씨", brief: "인권 단체 활동가", letter: ["단체에서 일합니다"], required: false, personal: false }],
      me: st.me === undefined ? { id: "p1", name: "김씨", letter: ["안녕하세요"], personal: true } : st.me, materials: [],
      cases: [{ id: "canada", country: "캐나다", title: "민간 후원 제도", what: "시민이 난민을 후원한다.", result: "정착이 빠르다는 평가가 있다.", think: "제주와 비교하면?", links: [{ title: "기사", outlet: "정부", date: "2016-09", url: "https://example.org/a" }, { title: "위험", outlet: "x", url: "javascript:alert(1)" }] },
              { id: "uganda", country: "우간다", title: "열린 정책", what: "땅을 준다.", result: "한계가 드러났다.", think: "다르다.", links: [] }],
      aftermath: [{ kind: "사실", text: "많은 사람이 육지로 떠났다.", links: [{ outlet: "세계일보", date: "2019-06-20", url: "https://example.org/b" }] }],
      ui: { letterSign: "2018년 12월, 제주에서", requiredWho: "고향을 떠나 온 당사자(예멘에서 온 분)", requiredTag: "당사자", compareWith: "제주", afterSince: "2018년 12월", casesKinds: "받아들이는 정책과 막는 정책" },
      ...st.caseExtra });
    if (name === "joinSession") { if (!data.code) throw new Error("functions: 입장 미리 깨우기"); st.joined.push(data); if (st.joinDelay) await new Promise((r) => setTimeout(r, st.joinDelay)); if (data.password !== "pw1234") throw new Error("functions: 비밀번호가 맞지 않습니다."); return { groupId: "g1", nickname: data.nickname, started: st.started !== false, chatLimit: st.chatLimit || 5, case: caseData() }; }
    if (name === "getCase") return caseData();
    if (name === "choosePersona") { st.chose = data; if (st.chooseErr) throw new Error("functions: " + st.chooseErr); const l = caseData().letters.find((x) => x.id === data.personaId); return { me: { id: l.id, name: l.name, letter: l.letter, personal: l.personal } }; }
    if (name === "aiRequest") {
      st.chatCalls.push(data);
      await new Promise((r) => { st.releaseChat = r; });
      if (st.failNext) { st.failNext = false; throw new Error("functions: AI 응답을 받지 못했습니다."); }
      return { result: "답" };
    }
    return {};
  };
  return st;
}
const HELP_KEYS = ["1-pick", "1-chat", "1-note", "1-group", "2", "3", "4", "5", "6", "7"];
async function openStudent(st, { member = {}, work = {}, session = { chatLimit: 5 }, page = "index.html", ctxOpts, help = false, chatLocked = false, picks = { p1: { uid: "anonX", nick: "가람" } }, chat = [{ id: "c1", input: "안녕하세요", output: "네, 안녕하세요", model: "m" }] } = {}) {
  // 대부분의 테스트는 단계 안내 팝업을 이미 본 상태에서 시작한다(팝업이 화면을 가리므로). help:true 로 처음 보는 학생을 만든다.
  const s = await newPage(({ member, work, session, seen, chat, chatLocked, picks }) => {
    if (seen) { try { localStorage.setItem("eps_help_ABC234_g1_가람", JSON.stringify(seen)); } catch {} }
    window.__user = null; window.__anonUid = "anonX";
    window.__docs = { "sessions/ABC234": session, "sessions/ABC234/members/anonX": { groupId: "g1", nickname: "가람", ...(chatLocked ? { chatLocked: true, conduct: { strikes: 3, total: 3 } } : {}), ...member }, "sessions/ABC234/groups/g1": { work, picks } };
    window.__cols = { "sessions/ABC234/members/anonX/chat": chat };
  }, st.handler, { member, work, session, seen: help ? null : HELP_KEYS, chat, chatLocked, picks }, ctxOpts);
  await s.pg.goto(`${base}/${page}`);
  await s.pg.waitForSelector("#j-pw");
  return s;
}
async function login(pg, ready = "#app:not(.hidden)") {
  await pg.fill("#j-code", "abc234"); await pg.fill("#j-group", "1"); await pg.fill("#j-nick", "가람"); await pg.fill("#j-pw", "pw1234");
  await pg.click("#j-btn");
  await pg.waitForSelector(ready);
}

test("학생: 입장 폼 — 빈 칸이면 요청하지 않고, 틀린 비밀번호는 실패, 맞으면 입장하며 로그아웃 버튼이 생긴다", async () => {
  const st = studentFixture(), { pg, errors } = await openStudent(st);
  assert.ok(!(await pg.locator("#logout").isVisible()));
  await pg.fill("#j-code", "abc234"); await pg.fill("#j-group", "1"); await pg.fill("#j-nick", "가람");
  await pg.click("#j-btn");
  assert.equal(st.joined.length, 0);
  await pg.fill("#j-pw", "bad"); await pg.click("#j-btn");
  await pg.waitForFunction(() => window.__log.filter((n) => n === "joinSession").length >= 2); // 입장 미리 깨우기 + 이번 요청
  assert.ok(!(await pg.locator("#app").isVisible()));
  await pg.fill("#j-pw", "pw1234"); await pg.click("#j-btn");
  await pg.waitForSelector("#app:not(.hidden)");
  assert.ok(await pg.locator("#logout").isVisible());
  assert.equal(await pg.evaluate(() => sessionStorage.getItem("eps_code")), "ABC234");
  assert.equal(await pg.evaluate(() => localStorage.getItem("eps_code")), null);
  assert.equal(await pg.inputValue("#j-pw"), "");
  assert.deepEqual(errors, []);
});

test("학생: 로그아웃하면 입장 정보가 지워지고 처음 화면으로 돌아간다", async () => {
  const st = studentFixture(), { pg } = await openStudent(st);
  await login(pg);
  await pg.click("#logout");
  assert.match(await pg.locator(".modal").innerText(), /로그아웃할까요/);
  const nav = pg.waitForNavigation();
  await pg.click(".modal .btn-primary"); await nav;
  await pg.waitForSelector("#j-pw");
  assert.equal(await pg.evaluate(() => sessionStorage.getItem("eps_code")), null);
  assert.ok(await pg.locator("#join").isVisible());
});

test("학생: 편지 서명은 사건마다 서버가 보낸 문구를 쓴다", async () => {
  const st = studentFixture();
  st.caseExtra = { ui: { letterSign: "2019년 2월", goodQuestion: "평택항으로 돌아온 쓰레기는 몇 t인가?" } };
  const { pg } = await openStudent(st);
  await login(pg);
  await pg.waitForSelector("details.letter .sign", { state: "attached" }); // 대화가 있으면 편지는 접혀 있다
  const sign = await pg.locator("details.letter .sign").textContent();
  assert.match(sign, /2019년 2월/);
  assert.doesNotMatch(sign, /제주/);
});

test("학생: 인물의 답을 기다리는 동안 움직이는 표시·흐르는 초·안내가 보이고, 실패하면 오류와 '다시 보내기'가 나온다", async () => {
  const st = studentFixture(), { pg } = await openStudent(st);
  await login(pg);
  await pg.waitForSelector("#msg");
  await pg.fill("#msg", "질문입니다");
  await pg.press("#msg", "Enter");
  await pg.waitForSelector("#msgs .wait");
  assert.ok(await pg.locator("#msgs .wait .wait-msg").isVisible());
  assert.match(await pg.locator("#msgs .wait").innerText(), /연결은 살아 있어요/);
  await pg.waitForFunction(() => Number(document.querySelector("#msgs .wait-sec")?.textContent) >= 2, null, { timeout: 5000 });
  assert.equal(st.chatCalls.length, 1);
  st.failNext = true; st.releaseChat();
  await pg.waitForSelector('#msgs [data-act="retry-chat"]');
  assert.match(await pg.locator("#msgs .msg.err").innerText(), /답을 받지 못했어요/);
  assert.equal(await pg.locator("#msgs .wait").count(), 0, "끝나면 기다리는 표시는 사라진다");
  await pg.click('#msgs [data-act="retry-chat"]');
  await pg.waitForFunction(() => true);
  await pg.waitForSelector("#msgs .wait");
  assert.equal(st.chatCalls.length, 2);
  assert.equal(st.chatCalls[1].payload.message, "질문입니다", "같은 질문을 다시 보낸다");
  st.releaseChat();
});

test("학생: 인터넷이 끊기면 알림 띠가 뜨고 다시 연결되면 사라진다. 저장이 늦어지면 '저장 중'이 보인다", async () => {
  const st = studentFixture(), { pg, ctx } = await openStudent(st);
  await login(pg);
  assert.match(await pg.locator("#net").innerText(), /연결됨/);
  await ctx.setOffline(true);
  await pg.waitForSelector("#net-banner");
  assert.match(await pg.locator("#net-banner").innerText(), /자동으로 저장/);
  assert.match(await pg.locator("#net").innerText(), /연결 끊김/);
  await ctx.setOffline(false);
  await pg.waitForFunction(() => !document.querySelector("#net-banner"));
  await pg.evaluate(() => { window.__hangWrites = true; });
  await pg.click('[data-go="1"][data-sub="note"]');
  await pg.waitForSelector("textarea[data-save], input[data-save]");
  await pg.locator("textarea[data-save], input[data-save]").first().fill("메모");
  await pg.locator("textarea[data-save], input[data-save]").first().blur();
  await pg.waitForFunction(() => /저장/.test(document.querySelector("#net").innerText));
});

test("학생: '대화 저장'으로 내 대화를 글 파일로 내려받는다", async () => {
  const st = studentFixture(), { pg } = await openStudent(st);
  await login(pg);
  await pg.waitForSelector('[data-act="dl-chat"]');
  const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click('[data-act="dl-chat"]')]);
  assert.match(dl.suggestedFilename(), /^ai-eps-chat-\d{4}-\d{2}-\d{2}\.txt$/);
  const text = fs.readFileSync(await dl.path(), "utf8");
  assert.match(text, /\[나\] 안녕하세요/); assert.match(text, /\[김씨\] 네, 안녕하세요/);
});

test("접근성: 대화창은 읽어 주는 영역(role=log), 오류·알림은 role=alert/status, 건너뛰기 링크와 단계 탭 aria-current", async () => {
  const st = studentFixture(), { pg } = await openStudent(st);
  assert.equal(await pg.locator("a.skip").count(), 1);
  await login(pg);
  assert.equal(await pg.locator("#msgs").getAttribute("role"), "log");
  assert.equal(await pg.locator(".stage-tab[aria-current='step']").count(), 1);
  assert.equal(await pg.locator("#net").getAttribute("role"), "status");
});

test("머리글: 학교 마크(webp)와 모형 이름이 보인다", async () => {
  const st = studentFixture(), { pg } = await openStudent(st);
  assert.match(await pg.title(), /AI-EPS: 확장된 경험 기반 문제해결학습 모형/);
  await pg.waitForFunction(() => document.querySelector(".hdr img.mark")?.complete);
  assert.ok(await pg.evaluate(() => document.querySelector(".hdr img.mark").naturalWidth > 0), "마크 이미지가 불러와져야 한다");
  assert.match(await pg.getAttribute(".hdr img.mark", "src"), /\.webp$/);
  assert.match(await pg.locator(".hdr .brand").innerText(), /확장된 경험 기반 문제해결학습 모형/);
});

test("학생: 남은 질문 수가 보이고, 수업에서 정한 횟수를 다 쓰면 입력이 막히고 ② 정리로 안내한다", async () => {
  const a = await openStudent(studentFixture(), { member: { chatCount: 2 }, session: { chatLimit: 5 } });
  await login(a.pg);
  await a.pg.waitForFunction(() => /남은 질문 3 \/ 5번/.test(document.querySelector("#chat-left")?.innerText || ""));
  assert.ok(!(await a.pg.locator("#msg").isDisabled()));
  const b = await openStudent(studentFixture(), { member: { chatCount: 3 }, session: { chatLimit: 3 } });
  await login(b.pg);
  await b.pg.waitForFunction(() => /질문을 모두 썼어요/.test(document.querySelector("#chat-left")?.innerText || ""));
  assert.ok(await b.pg.locator("#msg").isDisabled());
  assert.ok(await b.pg.locator("#send-btn").isDisabled());
  await b.pg.click('#chat-left [data-go="1"][data-sub="note"]');
  await b.pg.waitForSelector('[data-act="submit-note"]');
});

test("학생: 단계 순서 — 핵심 원인 전에는 4단계 AI 검토, 최종 대안 전에는 5단계 시뮬레이션이 잠겨 있다", async () => {
  const proposals = { a1: { text: "가".repeat(40), t: 1 } };
  const s1 = await openStudent(studentFixture(), { work: { s4: { proposals } } });
  await login(s1.pg);
  await s1.pg.click('.stage-tab[data-stage="4"]');
  await s1.pg.waitForSelector('[data-act="ask-feedback"]');
  assert.ok(await s1.pg.locator('[data-act="ask-feedback"]').isDisabled());
  assert.match(await s1.pg.locator("#panel").innerText(), /가장 큰 원인을 먼저 정해야/);
  await s1.pg.click('.stage-tab[data-stage="5"]');
  await s1.pg.waitForFunction(() => /최종 해결책을 30자 이상 먼저 써야/.test(document.querySelector("#panel").innerText));
  assert.equal(await s1.pg.locator('[data-act="ask-scenario"]').count(), 0);
  const s2 = await openStudent(studentFixture(), { work: { s3: { chain: { cause: "취업 허가가 늦어 생계가 막혔다" } }, s4: { proposals, final: "나".repeat(40) } } });
  await login(s2.pg);
  await s2.pg.click('.stage-tab[data-stage="4"]');
  await s2.pg.waitForSelector('[data-act="ask-feedback"]');
  assert.ok(!(await s2.pg.locator('[data-act="ask-feedback"]').isDisabled()));
  await s2.pg.click('.stage-tab[data-stage="5"]');
  await s2.pg.waitForSelector("#sp");
  assert.match(await s2.pg.locator("#sp").innerText(), /\[최종\]/);
});

test("교사: 새 수업을 만들 때 학생별 인물 질문 횟수를 정해 보내고, 학생 표에 쓴 횟수가 보인다", async () => {
  const st = teacherFixture(), { pg } = await openTeacher(st);
  // 학생 표는 수업을 연 뒤 비동기로 그려지므로 내용이 나올 때까지 기다린다
  await pg.waitForFunction(() => /0 \/ 5번/.test(document.querySelector("#students")?.innerText || ""));
  await pg.click("#back-btn");
  await pg.click("#new-toggle");
  assert.equal(await pg.inputValue("#t-chatlimit"), "5");
  await pg.fill("#t-chatlimit", "7");
  await pg.click("#create-btn");
  await pg.waitForFunction(() => window.__log.includes("createSession"));
  assert.equal(st.calls.find((c) => c[0] === "createSession")[1].chatLimit, 7);
});

// ---------- 모바일 전용 화면 ----------
const phone = { userAgent: IPHONE, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const shot = async (pg, name) => { if (process.env.SHOT_DIR) await pg.screenshot({ path: path.join(process.env.SHOT_DIR, name + ".png"), fullPage: false }); };
const idsOf = (file) => new Set([...fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test("모바일 화면은 PC 화면과 같은 id 를 모두 가진다(같은 app.js·teacher.js 로 움직이므로)", () => {
  for (const [pc, m] of [["index.html", "m.html"], ["teacher.html", "m-teacher.html"]]) {
    const a = idsOf(pc), b = idsOf(m);
    a.delete("to-mobile"); // PC 화면에만 있는 '모바일 화면으로 보기'
    assert.deepEqual([...a].filter((x) => !b.has(x)), [], `${m} 에 빠진 id`);
    assert.deepEqual([...b].filter((x) => !a.has(x)), [], `${m} 에만 있는 id`);
  }
});

test("휴대폰으로 학생·교사 화면을 열면 모바일 화면으로 옮겨 가고(쿼리 유지), PC에서는 그대로다", async () => {
  const s = await openStudent(studentFixture(), { ctxOpts: phone });
  assert.match(s.pg.url(), /\/m\.html$/);
  assert.ok(await s.pg.locator("body.m").count());
  await s.pg.goto(`${base}/index.html?x=1#top`);
  await s.pg.waitForURL(/\/m\.html\?x=1#top$/);
  const t = await newPage(() => { window.__user = null; window.__docs = {}; window.__cols = {}; }, async () => ({}), undefined, phone);
  await t.pg.goto(`${base}/teacher.html`);
  await t.pg.waitForURL(/\/m-teacher\.html$/);
  const d = await openStudent(studentFixture());
  assert.match(d.pg.url(), /\/index\.html$/);
  assert.ok(await d.pg.locator("#to-mobile").isHidden(), "PC에는 모바일 링크를 보이지 않는다");
});

test("휴대폰에서 'PC 화면으로 보기'를 고르면 기억하고, '모바일 화면으로 보기'로 되돌린다", async () => {
  const s = await openStudent(studentFixture(), { ctxOpts: phone });
  await s.pg.click("#join .m-switch a");
  await s.pg.waitForURL(/\/index\.html\?view=pc$/);
  await s.pg.goto(`${base}/index.html`);
  await s.pg.waitForSelector("#j-pw");
  assert.match(s.pg.url(), /\/index\.html$/, "PC 화면 선택을 기억한다");
  assert.ok(await s.pg.locator("#to-mobile").isVisible());
  await s.pg.click("#to-mobile a");
  await s.pg.waitForURL(/\/m\.html\?view=m$/);
  await s.pg.goto(`${base}/index.html`);
  await s.pg.waitForURL(/\/m\.html$/);
});

test("학생 모바일: 입장 → 아래 단계 막대로 이동, 글을 쓰는 동안 막대를 숨기고, 남은 질문이 보인다", async () => {
  const s = await openStudent(studentFixture(), { ctxOpts: phone, member: { chatCount: 1 } });
  assert.ok(await s.pg.locator(".m-hero").isVisible());
  await shot(s.pg, "m-join");
  await login(s.pg);
  await s.pg.waitForSelector("#tabs .stage-tab");
  assert.equal(await s.pg.locator("#tabs.m-nav .stage-tab").count(), 7);
  const nav = await s.pg.locator("#tabs").boundingBox();
  assert.ok(nav.y + nav.height >= 844 - 1, "단계 막대는 화면 맨 아래에 붙는다");
  await s.pg.waitForFunction(() => /남은 질문 4 \/ 5번/.test(document.querySelector("#chat-left")?.innerText || ""));
  await shot(s.pg, "m-chat");
  await s.pg.tap("#msg");
  await s.pg.waitForFunction(() => document.body.classList.contains("typing"));
  assert.ok(await s.pg.locator("#tabs").isHidden());
  await s.pg.locator("#msg").blur();
  await s.pg.waitForFunction(() => !document.body.classList.contains("typing"));
  await s.pg.tap('#tabs .stage-tab[data-stage="3"]');
  await s.pg.waitForSelector('#tabs .stage-tab.on[data-stage="3"]');
  assert.match(await s.pg.locator("#panel").innerText(), /확인 질문 확인하기/);
  await shot(s.pg, "m-stage3");
  const w = await s.pg.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `가로로 밀리지 않아야 한다 (${w}px)`);
  assert.deepEqual(s.errors, []);
});

test("교사 모바일: 학생·모둠 표가 카드로 보이고, 아래 메뉴로 수업 설정을 연다", async () => {
  const st = teacherFixture(), { pg, errors } = await openTeacher(st, { page: "m-teacher.html", ctxOpts: phone });
  await pg.waitForSelector("#students tr");
  assert.equal(await pg.locator("#students tr").first().evaluate((el) => getComputedStyle(el).display), "grid");
  const nav = await pg.locator("#ctabs").boundingBox();
  assert.ok(nav.y + nav.height >= 844 - 1, "수업 메뉴는 화면 맨 아래에 붙는다");
  await shot(pg, "m-teacher-live");
  await pg.locator("#students tr").first().scrollIntoViewIfNeeded();
  await shot(pg, "m-teacher-students");
  await pg.tap('#ctabs [data-ctab="settings"]');
  assert.ok(await pg.locator("#cpane-settings").isVisible());
  await pg.waitForFunction(() => document.querySelector("#s-chatlimit").value !== "");
  const w = await pg.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `가로로 밀리지 않아야 한다 (${w}px)`);
  await shot(pg, "m-teacher-settings");
  assert.deepEqual(errors, []);
});

test("학생 모바일: 안내 글은 한 줄로 줄이고(누르면 펼침, 다시 그려도 유지), AI 역할 상자(개발자용 설명)는 보이지 않고, 사건 자료(학습 내용)는 펼친 채로 시작한다", async () => {
  const s = await openStudent(studentFixture(), { ctxOpts: phone });
  await login(s.pg);
  await s.pg.waitForSelector(".subnav");
  assert.equal(await s.pg.locator(".role").count(), 0, "AI 역할 상자는 학생 화면에 없다");
  await s.pg.tap('#tabs .stage-tab[data-stage="2"]');
  await s.pg.waitForSelector("details.fold");
  // 설명 글은 한 줄로 줄어 있고, 누르면 펼쳐지며, 화면을 다시 그려도 펼친 채로 있다
  const desc = s.pg.locator(".card .desc >> visible=true").first();
  const h1 = (await desc.boundingBox()).height;
  await desc.tap();
  await s.pg.waitForFunction(() => [...document.querySelectorAll(".card .desc")].some((e) => e.classList.contains("open")));
  assert.ok((await s.pg.locator(".card .desc.open").first().boundingBox()).height > h1 + 10, "누르면 펼쳐진다");
  await s.pg.evaluate(() => { const d = document.querySelector("#panel"); d.innerHTML = d.innerHTML; });
  await s.pg.waitForFunction(() => [...document.querySelectorAll(".card .desc")].some((e) => e.classList.contains("open")));
  assert.notEqual(await s.pg.locator("details.fold").getAttribute("open"), null, "사건 자료는 학습 내용이므로 펼쳐서 시작한다");
  await s.pg.locator("details.fold summary").tap();
  await s.pg.evaluate(() => window.scrollTo(0, 0));
  await s.pg.tap('#tabs .stage-tab[data-stage="3"]'); await s.pg.tap('#tabs .stage-tab[data-stage="2"]');
  await s.pg.waitForSelector("details.fold");
  assert.equal(await s.pg.locator("details.fold").getAttribute("open"), null, "학생이 접은 상자는 다시 그려도 접힌 채로");
  assert.ok(await s.pg.locator(".nav-foot + .m-hide, .m-hide").first().isHidden());
});

// ---------- 단계 안내 팝업 · 대기실 · 로그아웃 · 모둠 이동 ----------
test("학생: 단계에 처음 들어가면 안내 팝업이 뜨고, '이해 못했어요'는 자세한 설명, '이해했어요'를 누르면 바로 활동. 본 단계는 다시 뜨지 않고 ? 버튼으로 다시 본다", async () => {
  const { pg, errors } = await openStudent(studentFixture(), { help: true });
  await login(pg);
  await pg.waitForSelector(".modal");
  assert.match(await pg.locator(".modal h3").innerText(), /1단계 ① 한 사람을 만나 보세요/);
  const simple = await pg.locator(".modal").innerText();
  assert.match(simple, /무엇을 해요\?/); assert.match(simple, /어떻게 해요\?/); assert.match(simple, /질문은 5번뿐/, "이 수업의 질문 횟수가 들어간다");
  assert.equal(await pg.locator(".modal-acts .btn").count(), 2);
  await pg.click('.modal .btn:has-text("이해 못했어요")');
  await pg.waitForSelector(".modal .help-steps");
  assert.ok((await pg.locator(".modal .help-steps li").count()) >= 3);
  assert.match(await pg.locator(".modal").innerText(), /💡/);
  await pg.click('.modal .btn:has-text("간단히 보기")');
  await pg.waitForSelector(".modal .help-what");
  await pg.click('.modal .btn:has-text("이해했어요")');
  await pg.waitForFunction(() => !document.querySelector(".modal"));
  await shot(pg, "m-help-after");
  await pg.fill("#msg", "질문이에요");
  assert.equal(await pg.inputValue("#msg"), "질문이에요", "팝업을 닫으면 바로 활동할 수 있다");
  await pg.click('#tabs .stage-tab[data-stage="2"]');
  await pg.waitForSelector(".modal");
  assert.match(await pg.locator(".modal h3").innerText(), /2단계/);
  await pg.click('.modal .btn:has-text("이해했어요")');
  await pg.click('#tabs .stage-tab[data-stage="1"]');
  await pg.waitForSelector("#msgs");
  await pg.waitForTimeout(250);
  assert.equal(await pg.locator(".modal").count(), 0, "이미 본 단계는 다시 뜨지 않는다");
  await pg.click("#help-btn");
  await pg.waitForSelector(".modal .help-what");
  await pg.click('.modal .btn:has-text("이해했어요")');
  assert.deepEqual(errors, []);
});

test("학생 모바일: 안내 팝업은 아래에서 올라오는 창으로 뜨고 화면 밖으로 넘치지 않는다", async () => {
  const s = await openStudent(studentFixture(), { ctxOpts: phone, help: true });
  await login(s.pg);
  await s.pg.waitForSelector(".modal");
  await s.pg.waitForTimeout(400);
  await shot(s.pg, "m-help");
  const b = await s.pg.locator(".modal").boundingBox();
  assert.ok(b.y + b.height >= 844 - 1 && b.x >= 0 && b.x + b.width <= 390, "아래에 붙고 가로로 넘치지 않는다");
  await s.pg.click('.modal .btn:has-text("이해 못했어요")');
  await s.pg.waitForSelector(".modal .help-steps");
  await s.pg.waitForTimeout(400); // 올라오는 움직임이 끝난 뒤
  await shot(s.pg, "m-help-detail");
  assert.ok((await s.pg.locator(".modal").boundingBox()).height <= 844 * 0.9 + 1);
});

test("학생: 선생님이 시작하기 전에는 대기실이 보이고(개발 용어 없이 여정·안내), 시작하면 활동 화면과 첫 안내가 뜬다", async () => {
  const stW = studentFixture(); stW.started = false; stW.chatLimit = 4;
  const { pg, errors } = await openStudent(stW, { session: { chatLimit: 4, started: false }, help: true });
  await login(pg, "#wait:not(.hidden)");
  assert.ok(await pg.locator("#app").isHidden());
  const t = await pg.locator("#wait").innerText();
  assert.match(t, /곧 시작해요/); assert.match(t, /오늘의 여정/); assert.match(t, /질문은 4번/); assert.match(t, /1모둠 · 가람/);
  assert.equal(await pg.locator("#wait .journey li").count(), 7);
  assert.doesNotMatch(t, /AI-EPS|GYR|서버|세션|워크스페이스|로딩/);
  assert.ok(await pg.locator("#logout").isVisible(), "대기실에서도 로그아웃할 수 있다");
  assert.equal(await pg.locator(".modal").count(), 0, "대기 중에는 단계 안내 팝업이 뜨지 않는다");
  await shot(pg, "m-wait");
  await pg.evaluate(() => window.__push("sessions/ABC234", { chatLimit: 4, started: true }));
  await pg.waitForSelector("#app:not(.hidden)");
  assert.ok(await pg.locator("#wait").isHidden());
  await pg.waitForSelector(".modal .help-what");
  assert.match(await pg.locator(".modal h3").innerText(), /한 사람을 만나/);
  assert.deepEqual(errors, []);
});

test("학생 모바일 대기실: 한 화면 안에 보이고 가로로 넘치지 않는다", async () => {
  const { pg } = await openStudent(studentFixture(), { ctxOpts: phone, session: { chatLimit: 5, started: false } });
  await login(pg, "#wait:not(.hidden)");
  assert.ok((await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await shot(pg, "m-wait-phone");
});

test("학생: 선생님이 다른 모둠으로 옮기면 로그아웃되지 않고 새 모둠으로 화면이 다시 열리며 안내가 나온다", async () => {
  const { pg } = await openStudent(studentFixture());
  await login(pg);
  const nav = pg.waitForNavigation();
  await pg.evaluate(() => window.__push("sessions/ABC234/members/anonX", { groupId: "g2", nickname: "가람" }));
  await nav;
  await pg.waitForSelector(".toast");
  assert.match(await pg.locator(".toast").first().innerText(), /2모둠으로 옮겨 주셨어요/);
  assert.equal(await pg.evaluate(() => sessionStorage.getItem("eps_code")), "ABC234", "로그아웃하지 않는다");
});

test("학생: 로그아웃은 한 번 확인하고, '계속하기'를 누르면 그대로 있다", async () => {
  const { pg } = await openStudent(studentFixture());
  await login(pg);
  await pg.click("#logout");
  await pg.click('.modal .btn:has-text("계속하기")');
  await pg.waitForFunction(() => !document.querySelector(".modal"));
  assert.equal(await pg.evaluate(() => sessionStorage.getItem("eps_code")), "ABC234");
  await pg.click("#logout");
  await pg.keyboard.press("Escape");
  await pg.waitForFunction(() => !document.querySelector(".modal"));
  assert.ok(await pg.locator("#app").isVisible());
});

test("교사: 대기실에서 모둠별 입장 현황을 보고, 모둠을 옮기고, 확인 창을 거쳐 수업을 시작한다", async () => {
  const st = teacherFixture(), { pg, errors } = await openTeacher(st, { session: { started: false } });
  await pg.waitForSelector("#lobby:not(.hidden)");
  const t = await pg.locator("#lobby").innerText();
  assert.match(t, /2명 입장/); assert.match(t, /1모둠/); assert.match(t, /가람/); assert.match(t, /나래/); assert.match(t, /아직 없음/);
  assert.match(await pg.locator("#open-note").innerText(), /대기 중/);
  assert.match(await pg.locator("#start-btn").innerText(), /수업 시작하기 \(2명\)/);
  await pg.locator('#lobby [data-move="u2"]').click();
  await pg.locator('.modal .btn:has-text("3모둠")').click();
  await pg.waitForFunction(() => window.__log.includes("moveStudent"));
  assert.deepEqual(st.calls.find((c) => c[0] === "moveStudent")[1], { code: "ABC234", uid: "u2", groupNo: 3 });
  await pg.click("#start-btn");
  assert.match(await pg.locator(".modal").innerText(), /수업을 시작할까요/);
  assert.match(await pg.locator(".modal").innerText(), /접속이 끊긴 학생이 2명/);
  await pg.click('.modal .btn:has-text("아직이요")');
  assert.ok(!st.calls.some((c) => c[0] === "updateSession"), "취소하면 시작하지 않는다");
  await pg.click("#start-btn");
  await pg.click('.modal .btn:has-text("수업 시작")');
  await pg.waitForFunction(() => window.__log.includes("updateSession"));
  assert.deepEqual(st.calls.find((c) => c[0] === "updateSession")[1], { code: "ABC234", started: true });
  assert.deepEqual(errors, []);
});

test("교사: 이미 시작된 수업에는 대기실이 보이지 않는다(예전 수업 포함)", async () => {
  const { pg } = await openTeacher(teacherFixture());
  assert.ok(await pg.locator("#lobby").isHidden());
  assert.match(await pg.locator("#open-note").innerText(), /진행 중/);
});

test("교사 모바일: 대기실 카드와 모둠 이동 선택 창이 휴대폰 화면 안에 보인다", async () => {
  const st = teacherFixture(), { pg } = await openTeacher(st, { page: "m-teacher.html", ctxOpts: phone, session: { started: false } });
  await pg.waitForSelector("#lobby:not(.hidden)");
  await shot(pg, "m-teacher-lobby");
  await pg.locator('#lobby [data-move="u1"]').tap();
  await pg.waitForSelector(".modal");
  await pg.waitForTimeout(400);
  await shot(pg, "m-teacher-move");
  const b = await pg.locator(".modal").boundingBox();
  assert.ok(b.x >= 0 && b.x + b.width <= 390);
  assert.ok((await pg.evaluate(() => document.documentElement.scrollWidth)) <= 390);
});

// ---------- 모바일: 학습 활동 공간 ----------
test("학생 모바일: 머리글·아래 막대가 얇고, 1단계 대화창이 화면의 대부분을 쓰며, 알아낼 것이 한 줄 칩으로 보인다", async () => {
  const { pg } = await openStudent(studentFixture(), { ctxOpts: phone });
  await login(pg);
  await pg.waitForSelector("#msgs");
  const hdr = await pg.locator(".hdr").boundingBox(), nav = await pg.locator("#tabs").boundingBox();
  assert.ok(hdr.height <= 46, `머리글 ${hdr.height}px`);
  assert.ok(nav.height <= 58, `아래 막대 ${nav.height}px`);
  const chips = await pg.locator(".goal-chips").innerText();
  assert.match(chips, /알아낼 것/); assert.match(chips, /누구인지/); assert.match(chips, /힘든 것/); assert.match(chips, /바라는 것/);
  assert.ok(await pg.locator(".goal-chips").isVisible());
  assert.ok(await pg.locator(".notice.pc-only").isHidden(), "긴 '할 일' 안내문은 모바일에서 숨긴다");
  const card = await pg.locator(".chat-card").boundingBox();
  assert.ok(card.height >= 844 * 0.6, `대화창 높이 ${card.height}px`);
  const cr = await pg.locator("#chat-form").boundingBox();
  assert.ok(cr.y + cr.height <= 844 - nav.height + 2, "입력창은 아래 막대 바로 위에 보인다");
  assert.ok(await pg.locator(".starters").isHidden(), "대화가 시작되면 예시 질문 줄을 접는다");
  await pg.waitForFunction(() => /남은 질문 5 \/ 5번/.test(document.querySelector("#chat-left")?.innerText || ""));
  const left = await pg.locator("#chat-left").boundingBox();
  assert.ok(left && left.height > 8 && left.y >= cr.y - 1 && left.y + left.height <= 844 - nav.height, "남은 질문 수가 입력창 위에 붙어 화면 안에 보인다");
  const sub = await pg.locator(".subnav button").first().boundingBox();
  assert.ok(sub.height <= 44, `작은 단계 막대 ${sub.height}px`);
  await shot(pg, "m-chat-space");
});

test("학생 모바일: 대화 전에는 예시 질문이 보이고, PC 화면에는 '알아낼 것' 칩이 없다", async () => {
  const m = await openStudent(studentFixture(), { ctxOpts: phone, chat: [] });
  await login(m.pg);
  // 입장 직후에는 화면을 몇 번 다시 그리므로(인물·대화 기록 도착), 그 순간에 바로 확인하지 않고 보일 때까지 기다린다
  await m.pg.waitForSelector("#msgs");
  await m.pg.waitForSelector(".starters", { state: "visible" });
  const d = await openStudent(studentFixture(), { chat: [] });
  await login(d.pg, "#msgs");
  await d.pg.waitForSelector(".notice.pc-only", { state: "visible" });
  assert.ok(await d.pg.locator(".goal-chips").isHidden());
});

test("학생 모바일: 아래로 스크롤하면 머리글·아래 막대가 숨고, 위로 스크롤하면 다시 나타난다", async () => {
  const { pg } = await openStudent(studentFixture(), { ctxOpts: phone });
  await login(pg);
  await pg.tap('#tabs .stage-tab[data-stage="2"]');
  await pg.waitForSelector("details.fold");
  await pg.evaluate(() => { document.body.style.minHeight = "3000px"; });
  assert.equal(await pg.evaluate(() => document.body.classList.contains("chrome-hidden")), false);
  await pg.evaluate(() => window.scrollTo(0, 500));
  await pg.waitForFunction(() => document.body.classList.contains("chrome-hidden"));
  await pg.waitForTimeout(400); // 내려가는 움직임이 끝난 뒤
  const nav = await pg.locator("#tabs").boundingBox();
  assert.ok(nav.y >= 844 - 1, "아래 막대가 화면 밖으로 내려간다");
  await pg.evaluate(() => window.scrollTo(0, 300));
  await pg.waitForFunction(() => !document.body.classList.contains("chrome-hidden"));
  await pg.evaluate(() => window.scrollTo(0, 600));
  await pg.waitForFunction(() => document.body.classList.contains("chrome-hidden"));
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForFunction(() => !document.body.classList.contains("chrome-hidden"));
});

test("학생 모바일: 2·3·4단계에서 학습 내용이 화면 첫머리부터 보인다(캡처)", async () => {
  const work = {
    s1: { problem: { hmw: "어떻게 하면 주민의 불안을 줄이면서도 신청자의 생계를 지킬 수 있을까?", situation: "신청자는 일자리를 구하기 어렵고 주민은 불안해한다." } },
    s2: { checks: { c1: { heard: "아델: 일자리를 구하기 어려웠다", question: "2018년 제주의 난민 신청자는 합법적으로 일할 수 있었나?", srcType: "법·제도", t: 1 } }, causes: { q1: { level: "제도·정책", text: "신청자가 일할 수 있는 길이 좁았다", t: 1 } } },
    s3: { chain: { cause: "취업 허가가 늦어 생계가 막혔다" } },
  };
  const st = studentFixture();
  const s = await openStudent(st, { ctxOpts: phone, work });
  await login(s.pg);
  for (const n of [2, 3, 4]) {
    await s.pg.tap(`#tabs .stage-tab[data-stage="${n}"]`);
    await s.pg.waitForSelector(`#tabs .stage-tab.on[data-stage="${n}"]`);
    await s.pg.waitForTimeout(200);
    await shot(s.pg, `m-stage${n}-space`);
    assert.ok((await s.pg.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  }
});

test("학생: 인물과 처음 이야기하기 전에 '처음 내 생각'을 한 줄 적어야 하고, 정리 화면에 그 생각이 함께 보인다", async () => {
  const st = studentFixture(), { pg } = await openStudent(st, { chat: [] });
  await login(pg, "#msgs");
  assert.match(await pg.locator(".card.prior").innerText(), /이야기를 듣기 전에/);
  await pg.fill("#msg", "어디서 오셨어요?");
  await pg.press("#msg", "Enter");
  await pg.waitForSelector(".toast");
  assert.match(await pg.locator(".toast").last().innerText(), /내 생각을 한 줄/);
  assert.equal(st.chatCalls.length, 0, "처음 생각을 적기 전에는 보내지 않는다");
  await pg.fill("#prior-in", "돈 벌러 온 사람들 같았다");
  await pg.fill("#msg", "어디서 오셨어요?");
  await pg.press("#msg", "Enter");
  await pg.waitForFunction(() => window.__log.includes("aiRequest"));
  assert.equal(st.chatCalls.length, 1);
  st.releaseChat();
  await pg.click('.subnav button[data-sub="note"]');
  await pg.waitForSelector("text=대화 전 내 생각");
  assert.match(await pg.locator(".notice.muted").first().innerText(), /돈 벌러 온 사람들/);
  assert.match(await pg.content(), /내 생각과 다르네/);
});

test("학생: 2단계 ①은 처음 내 생각에서 출발하고, 생각 도우미의 질문을 보고 더 쓸 수 있으며, 선생님이 끄면 도우미가 사라진다", async () => {
  const work = {
    s1: { findings: { anonX: { prior: "돈 벌러 온 사람들 같았다", surprise: "징집을 피해 왔다는 말을 들었다" } }, problem: { hmw: "어떻게 하면 주민의 불안을 줄이면서도 신청자의 생계를 지킬 수 있을까?", disputes: "주민은 범죄가 늘었다고 했는데, 활동가는 아니라고 했다" } },
    s2: { links: { L1: { by: "anonX", nick: "가람", prior: "돈 벌러 온 사람들 같았다", source: "뉴스 제목만 봤다", angle: "내가 그 사람 쪽에 서 봤던 때", scene: "전학 간 첫날 아무도 말을 안 걸었다", question: "사람들은 왜 낯선 사람을 먼저 의심할까?", t: 1 },
      L2: { by: "other", nick: "나래", source: "주변 어른들 말", scene: "우리 동네에도 외국인 노동자가 많다", t: 2 } } },
  };
  const st = studentFixture();
  const s = await openStudent(st, { work });
  await s.pg.evaluate(() => { window.__cols["sessions/ABC234/groups/g1/logs"] = [{ id: "g1log", stage: 2, type: "coach", output: JSON.stringify({ kind: "멀리 둠", question: "'뉴스 제목만 봤다'고 했는데, 그 제목은 어떤 말이었나요?" }), payload: { focus: "link", linkId: "L1", kind: "멀리 둠" }, createdAt: 1 }]; });
  await login(s.pg);
  await s.pg.click('#tabs .stage-tab[data-stage="2"]');
  await s.pg.waitForSelector("text=처음 내 생각 돌아보기");
  const body = await s.pg.locator("#panel").innerText();
  assert.match(body, /돈 벌러 온 사람들 같았다/);
  assert.match(body, /징집을 피해 왔다/);
  assert.match(body, /그 제목은 어떤 말이었나요/, "생각 도우미의 질문이 내 카드 아래에 보인다");
  assert.match(body, /질문을 받고 더 생각한 것/);
  assert.match(body, /나래/, "모둠원의 생각도 보인다");
  assert.match(body, /엇갈림/, "인물들이 다르게 말한 것이 확인할 질문 후보로 나온다");
  assert.doesNotMatch(body, /층위|가설|이해관계자|연결고리/);
  if (process.env.SHOT_DIR) await s.pg.locator(".card", { hasText: "처음 내 생각 돌아보기" }).screenshot({ path: path.join(process.env.SHOT_DIR, "stage2-link.png") });
  await s.pg.click('[data-act="ask-coach"][data-focus="link"]');
  await s.pg.waitForFunction(() => window.__log.includes("aiRequest"));
  assert.deepEqual(st.chatCalls.at(-1), { code: "ABC234", stage: 2, type: "coach", payload: { focus: "link", linkId: "L1" } });
  st.releaseChat();
  // 새 연결: 1·2번이 짧으면 막는다
  await s.pg.fill("#lk-src", "몰라");
  await s.pg.click('[data-act="add-link"]');
  await s.pg.waitForSelector(".toast");
  await s.pg.evaluate(() => window.__push("sessions/ABC234", { chatLimit: 5, coach: false }));
  await s.pg.waitForFunction(() => !document.querySelector('[data-act="ask-coach"]'));
  assert.doesNotMatch(await s.pg.locator("#panel").innerText(), /생각 도우미에게 보여 주기/);
});

// ---------- 브라우저·홈 화면 아이콘 ----------
const pngSize = (f) => { const b = fs.readFileSync(f); assert.equal(b.slice(1, 4).toString(), "PNG", `${f} 는 PNG 여야 한다`); return [b.readUInt32BE(16), b.readUInt32BE(20), b[25]]; }; // [가로, 세로, 색 종류(2=RGB, 6=RGBA)]
const headOf = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").split("</head>")[0];

test("아이콘: 학생용·교사용 PNG·ICO가 모두 있고 크기가 맞으며, 홈 화면용(iOS·마스크)은 투명이 없다", () => {
  for (const role of ["student", "teacher"]) {
    for (const [name, px] of [["512", 512], ["192", 192], ["maskable-512", 512], ["180", 180], ["32", 32], ["16", 16]]) {
      const [w, h] = pngSize(path.join(ROOT, `icons/${role}-${name}.png`));
      assert.deepEqual([w, h], [px, px], `${role}-${name}`);
    }
    assert.equal(pngSize(path.join(ROOT, `icons/${role}-180.png`))[2], 2, "iOS 아이콘은 투명 없는 RGB");
    assert.equal(pngSize(path.join(ROOT, `icons/${role}-maskable-512.png`))[2], 2, "마스크용 아이콘은 투명 없는 RGB");
    const ico = fs.readFileSync(path.join(ROOT, `icons/${role}.ico`));
    assert.equal(ico.readUInt16LE(2), 1, "ICO 형식"); assert.ok(ico.readUInt16LE(4) >= 3, "여러 크기가 들어 있다");
  }
  assert.ok(fs.statSync(path.join(ROOT, "favicon.ico")).size > 100, "기본 /favicon.ico (학생용)");
});

test("아이콘: 학생 화면(index, m)은 학생 아이콘, 교사 화면(teacher, m-teacher)은 교사 아이콘만 연결한다", () => {
  for (const [file, role, other, title] of [["index.html", "student", "teacher", "AI-EPS"], ["m.html", "student", "teacher", "AI-EPS"], ["teacher.html", "teacher", "student", "AI-EPS 교사"], ["m-teacher.html", "teacher", "student", "AI-EPS 교사"]]) {
    const h = headOf(file);
    for (const need of [`icons/${role}-32.png`, `icons/${role}-16.png`, `icons/${role}.ico`, `icons/${role}-180.png`, `manifest-${role}.webmanifest`]) assert.ok(h.includes(need), `${file} 에 ${need}`);
    assert.ok(!h.includes(`icons/${other}`) && !h.includes(`manifest-${other}`), `${file} 에 ${other} 아이콘이 섞이면 안 된다`);
    assert.ok(h.includes(`rel="apple-touch-icon" sizes="180x180"`));
    assert.ok(h.includes(`name="apple-mobile-web-app-title" content="${title}"`), `${file} 홈 화면 이름`);
    assert.ok(h.includes(`name="apple-mobile-web-app-capable"`));
  }
});

test("아이콘: 홈 화면 추가용 manifest 는 학생·교사가 따로이고, 가리키는 아이콘 파일이 모두 있다", () => {
  for (const [role, start, short] of [["student", "/", "AI-EPS"], ["teacher", "/teacher.html", "AI-EPS 교사"]]) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, `manifest-${role}.webmanifest`), "utf8"));
    assert.equal(m.short_name, short); assert.equal(m.start_url, start); assert.equal(m.display, "standalone"); assert.equal(m.id, `/${role}`);
    assert.ok(m.icons.some((i) => i.sizes === "192x192") && m.icons.some((i) => i.sizes === "512x512" && i.purpose === "any") && m.icons.some((i) => i.purpose === "maskable"));
    for (const i of m.icons) { assert.ok(i.src.startsWith(`icons/${role}`), i.src); const [w] = pngSize(path.join(ROOT, i.src)); assert.equal(`${w}x${w}`, i.sizes); }
  }
  assert.notDeepEqual(fs.readFileSync(path.join(ROOT, "icons/student-512.png")), fs.readFileSync(path.join(ROOT, "icons/teacher-512.png")), "학생용과 교사용 아이콘은 달라야 한다");
});

test("아이콘: 페이지를 열면 아이콘이 실제로 불러와지고 manifest 가 읽힌다(학생·교사)", async () => {
  for (const [file, role] of [["index.html", "student"], ["teacher.html", "teacher"]]) {
    const { pg } = await newPage(() => { window.__user = null; window.__docs = {}; window.__cols = {}; }, async () => ({}));
    const bad = []; pg.on("response", (r) => { if (/icons\/|webmanifest/.test(r.url()) && r.status() >= 400) bad.push(r.url()); });
    await pg.goto(`${base}/${file}`);
    assert.equal(await pg.evaluate(() => document.querySelector('link[rel="manifest"]').getAttribute("href")), `manifest-${role}.webmanifest`);
    const m = await pg.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
    assert.match(m.name, role === "student" ? /수업/ : /교사/);
    assert.deepEqual(bad, []);
  }
});

test("교사: 대화 규칙 위반 신호 카드·멈춘 학생 표시·대화 다시 열기 요청", async () => {
  const st = teacherFixture(), { pg, errors } = await openTeacher(st);
  await pg.waitForSelector("#conduct-card:not(.hidden)");
  await pg.waitForSelector('[data-unlock="u1"]');
  assert.match(await pg.locator("#conduct-list").innerText(), /놀리는 말/);
  assert.match(await pg.locator("#conduct-list").innerText(), /조롱·모욕/);
  assert.match(await pg.locator("#students").innerText(), /대화 멈춤/);
  assert.match(await pg.locator("#kpis").innerText(), /규칙 위반 신호/);
  assert.equal(await pg.locator("#conduct-card").count(), 1);
  assert.equal(await pg.locator("#alerts").count(), 1, "확인이 필요해요 카드와 id 가 겹치지 않는다");
  await pg.locator('[data-unlock="u1"]').click();
  await pg.waitForFunction(() => window.__log.includes("unlockChat"));
  assert.deepEqual(st.calls.find((c) => c[0] === "unlockChat")[1], { code: "ABC234", uid: "u1" });
  assert.deepEqual(errors, []);
});

test("학생: 교사가 멈춘 대화는 입력창이 안내로 바뀌고, 개인 인물/기관 인물에 따라 안내 문구가 다르다", async () => {
  const st = studentFixture(), { pg } = await openStudent(st, { chatLocked: true });
  await login(pg);
  await pg.waitForSelector(".composer.locked");
  assert.match(await pg.locator(".composer.locked").innerText(), /대화가 멈췄어요/);
  assert.equal(await pg.locator("#chat-form").count(), 0);
  assert.match(await pg.locator(".chat-head .st").innerText(), /대화 멈춤/);
  assert.match(await pg.locator(".chat-rule").innerText(), /개인적인 이야기도 자유롭게/);
  const st2 = studentFixture();
  const orig = st2.handler;
  st2.handler = async (n, d) => { const r = await orig(n, d); if (n === "joinSession") r.case.me.personal = false; return r; };
  const { pg: pg2 } = await openStudent(st2);
  await login(pg2);
  await pg2.waitForSelector(".chat-rule");
  assert.match(await pg2.locator(".chat-rule").innerText(), /단체·기관에서 일하는 사람/);
  assert.doesNotMatch(await pg2.locator(".chat-rule").innerText(), /자유롭게 물어볼 수 있어요/);
});

test("학생: 대화 중 받은 경고가 말풍선 사이에 표시된다", async () => {
  const st = studentFixture();
  const { pg } = await openStudent(st, { chat: [{ id: "c1", input: "놀리는 말", output: "상처받아요", conduct: { notice: "대화 규칙 위반으로 기록되었어요. (경고 1/3)", strikes: 1, locked: false } }] });
  await login(pg);
  await pg.waitForSelector(".sysmsg");
  assert.match(await pg.locator(".sysmsg").innerText(), /경고 1\/3/);
});

test("학생: 4단계 해외 사례 카드(탭 전환, 위험한 링크 차단)와 대안 추가(겨냥하는 원인·참고한 사례 입력칸) — 병합 때 대안을 못 추가하던 문제 방지", async () => {
  const st = studentFixture(), { pg } = await openStudent(st);
  await login(pg);
  await pg.click('.stage-tab[data-stage="4"]');
  await pg.waitForSelector(".case");
  assert.match(await pg.locator(".case").innerText(), /민간 후원 제도/);
  const hrefs = await pg.locator(".case-src a").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
  assert.deepEqual(hrefs, ["https://example.org/a", "#"], "javascript: 주소는 링크가 되지 않는다");
  await pg.click('[data-act="case-tab"][data-id="uganda"]');
  await pg.waitForFunction(() => document.querySelector(".case")?.innerText.includes("열린 정책"));
  assert.equal(await pg.locator("#pt-cause").count(), 1);
  assert.equal(await pg.locator("#pt-ref").count(), 1);
  await pg.fill("#pt", "누가: 도청이 / 무엇을: 정착 교육을 / 어떻게: 지역 단체와 함께 운영한다");
  await pg.fill("#pt-cause", "일자리 정보가 부족했다");
  await pg.selectOption("#pt-ref", { index: 1 });
  await pg.click('[data-act="add-proposal"]');
  await pg.waitForFunction(() => window.__writes.some((w) => Object.keys(w).some((k) => k.startsWith("work.s4.proposals."))));
  const w = await pg.evaluate(() => window.__writes.find((x) => Object.keys(x).some((k) => k.startsWith("work.s4.proposals."))));
  const v = Object.values(w)[0];
  assert.equal(v.cause, "일자리 정보가 부족했다");
  assert.match(v.ref, /캐나다/);
  assert.match(v.text, /정착 교육/);
});

test("학생: 7단계에 실제 이후 전개 자료와 비교 칸이 있다", async () => {
  const st = studentFixture(), { pg } = await openStudent(st);
  await login(pg);
  await pg.click('.stage-tab[data-stage="7"]');
  await pg.waitForSelector("textarea[data-save='s7.compare']");
  assert.match(await pg.locator("body").innerText(), /많은 사람이 육지로 떠났다/);
  assert.match(await pg.locator("body").innerText(), /세계일보/);
});

test("교사: 기록 CSV 내려받기 — 새 열(감독자 판정·개인정보 의심·웹 검색)이 들어 있고 버튼이 원래대로 돌아온다", async () => {
  const st = teacherFixture(), { pg, errors } = await openTeacher(st);
  const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click("#csv-btn")]);
  assert.equal(dl.suggestedFilename(), "ai-eps-ABC234.csv");
  const text = fs.readFileSync(await dl.path(), "utf8");
  assert.match(text, /개인정보 의심/); assert.match(text, /웹 검색/); assert.match(text, /감독자 판정/);
  await pg.waitForFunction(() => document.querySelector("#csv-btn").textContent.includes("기록 CSV") && !document.querySelector("#csv-btn").disabled);
  assert.deepEqual(errors, []);
});

// ---------- 입장 속도·인물 고르기·휴대폰 대화 ----------
test("학생: 입장하는 동안 '입장 중' 표시가 나오고, 입장 응답만으로 화면이 열린다(getCase 를 다시 부르지 않음)", async () => {
  const st = studentFixture(); st.joinDelay = 700;
  const { pg, errors } = await openStudent(st);
  await pg.fill("#j-code", "abc234"); await pg.fill("#j-group", "1"); await pg.fill("#j-nick", "가람"); await pg.fill("#j-pw", "pw1234");
  await pg.click("#j-btn");
  await pg.waitForSelector("#join-wait .wait");
  assert.match(await pg.locator("#j-btn").innerText(), /입장 중/);
  assert.ok(await pg.locator("#j-btn").isDisabled());
  await pg.waitForSelector("#app:not(.hidden)");
  assert.equal(await pg.locator("#join-wait").count(), 0);
  assert.ok(!st.calls.includes("getCase"), "입장 응답에 수업 내용이 들어 있다");
  assert.deepEqual(errors, []);
});

test("학생: 수업 시작 알림이 오지 않아도(휴대폰에서 실시간 연결이 늦는 경우) 몇 초 안에 서버를 다시 확인해 활동 화면으로 바뀐다", async () => {
  const st = studentFixture(); st.started = false;
  const { pg, errors } = await openStudent(st, { session: { chatLimit: 5, started: false } });
  await login(pg, "#wait:not(.hidden)");
  assert.ok(!(await pg.locator("#app").isVisible()));
  // 실시간 알림 없이 서버 문서만 바뀐 상황(구독 콜백을 거치지 않는다)
  await pg.evaluate(() => { window.__docs["sessions/ABC234"] = { chatLimit: 5, started: true }; });
  await pg.waitForSelector("#app:not(.hidden)", { timeout: 6000 });
  assert.deepEqual(errors, []);
});

test("학생: 인물을 아직 안 골랐으면 모든 인물의 편지가 보이고, 모둠이 이미 고른 인물은 못 고르며, 당사자가 없으면 안내한다", async () => {
  const st = studentFixture(); st.me = null;
  const { pg, errors } = await openStudent(st, { picks: { p2: { uid: "other", nick: "나래" } } });
  await login(pg);
  await pg.waitForSelector(".pcards");
  assert.equal(await pg.locator(".pcard").count(), 3);
  assert.match(await pg.locator(".subnav button.on").innerText(), /인물 고르기/);
  assert.ok(await pg.locator('.subnav button[data-sub="chat"]').isDisabled(), "고르기 전에는 대화로 갈 수 없다");
  assert.match(await pg.locator(".notice.yellow").innerText(), /예멘에서 온 분/);
  assert.match(await pg.locator(".pcard.taken").innerText(), /나래 선택/);
  assert.ok(await pg.locator('.pcard.taken [data-act="choose"]').isDisabled() === true || (await pg.locator('.pcard.taken [data-act="choose"]').count()) === 1);
  assert.ok(await pg.locator(".nav-foot .btn-primary").isDisabled());
  // 편지를 펼쳐 읽고 고른다
  await pg.click('.pcard[data-keep="pc-p1"] summary');
  assert.match(await pg.locator('.pcard[data-keep="pc-p1"] .pc-body').innerText(), /안녕하세요/);
  await pg.click('[data-act="choose"][data-id="p1"]');
  await pg.click(".modal .btn-primary");
  await pg.waitForSelector(".pcard.mine");
  assert.equal(st.chose.personaId, "p1");
  assert.match(await pg.locator(".notice.ok").innerText(), /김씨/);
  assert.equal(await pg.locator(".notice.yellow").count(), 0, "당사자를 골랐으니 안내가 사라진다");
  await pg.click('.notice.ok [data-sub="chat"]');
  await pg.waitForSelector("#msgs");
  assert.match(await pg.locator(".chat-head .nm").innerText(), /김씨/);
  assert.deepEqual(errors, []);
});

test("학생: 다른 사건(쓰레기 수출)이면 꼭 골라야 할 인물 안내와 사례 카드 비교 문구가 그 사건에 맞게 바뀐다", async () => {
  const st = studentFixture(); st.me = null;
  st.caseExtra = { ui: { letterSign: "2019년 2월", requiredWho: "쓰레기가 쌓인 필리핀 마을 쪽 사람", requiredTag: "필리핀 현지", compareWith: "이 사건", afterSince: "2019년 2월", casesKinds: "쓰레기를 막는 정책과 되돌려 보내는 정책" } };
  const { pg, errors } = await openStudent(st, { picks: {} });
  await login(pg);
  await pg.waitForSelector(".pcards");
  const notice = await pg.locator(".notice.yellow").innerText();
  assert.match(notice, /필리핀 마을 쪽 사람과 이야기해야/, "받침에 맞는 조사(과)");
  assert.doesNotMatch(notice, /예멘/);
  assert.match(await pg.locator(".pcard").first().innerText(), /필리핀 현지/);
  assert.deepEqual(errors, []);
});

test("학생: 인물 고르기 규칙 위반(겹침 등)은 서버 메시지를 그대로 보여 준다", async () => {
  const st = studentFixture(); st.me = null; st.chooseErr = "나래가 이미 고른 인물이에요. 다른 인물을 골라 보세요.";
  const { pg } = await openStudent(st, { picks: {} });
  await login(pg);
  await pg.waitForSelector(".pcards");
  await pg.click('.pcard[data-keep="pc-p2"] summary');
  await pg.click('[data-act="choose"][data-id="p2"]');
  await pg.click(".modal .btn-primary");
  await pg.waitForSelector(".toast.err");
  assert.match(await pg.locator(".toast.err").innerText(), /이미 고른/);
  assert.equal(await pg.locator(".pcard.mine").count(), 0);
});

test("학생(휴대폰): 대화 화면은 고정되고 대화창 안에서만 스크롤하며, 키보드가 올라오면(보이는 화면이 줄면) 입력창이 그 위에 붙는다", async () => {
  const st = studentFixture(), { pg, errors } = await openStudent(st, { page: "m.html", ctxOpts: phone, chat: Array.from({ length: 12 }, (_, i) => ({ id: "c" + i, input: "질문 " + i, output: "대답 ".repeat(20) + i })) });
  await login(pg);
  await pg.waitForSelector("body.chat-mode #msgs .msg");
  const lay = await pg.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const m = document.querySelector("#msgs");
    return { bodyH: document.documentElement.scrollHeight, vh: innerHeight, scrolls: m.scrollHeight > m.clientHeight, form: r("#chat-form"), msgs: r("#msgs"), letter: getComputedStyle(document.querySelector(".letter")).display };
  });
  assert.ok(lay.bodyH <= lay.vh + 1, "화면 전체는 스크롤되지 않는다");
  assert.ok(lay.scrolls, "대화창 안에서 스크롤된다");
  assert.equal(lay.letter, "none");
  assert.ok(lay.form.bottom <= 844 && lay.form.top > lay.msgs.top);
  // 가장 최근 말풍선이 보이게 맨 아래로 간다
  await pg.waitForFunction(() => { const m = document.querySelector("#msgs"); return m.scrollHeight - m.scrollTop - m.clientHeight < 6; });
  // 입력하면 머리글·작은 단계 막대·예시를 접고, 키보드로 보이는 화면이 줄어도 입력창이 보이는 화면 안에 있다
  await pg.click("#msg");
  await pg.waitForTimeout(200); // 초점 직후 화면 위치를 맨 위로 되돌리는 동작이 끝난 뒤
  await pg.evaluate(() => { document.documentElement.style.setProperty("--vvh", "420px"); });
  const typing = await pg.evaluate(() => {
    const vis = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== "none"; };
    return { hdr: vis(".hdr"), subnav: vis(".subnav"), nav: vis(".m-nav"), form: document.querySelector("#chat-form").getBoundingClientRect().bottom, h: document.body.getBoundingClientRect().height };
  });
  assert.equal(typing.hdr, false); assert.equal(typing.subnav, false); assert.equal(typing.nav, false);
  assert.ok(typing.form <= 421, "입력창이 보이는 화면(420px) 안에 있다: " + typing.form);
  assert.ok(Math.abs(typing.h - 420) < 2);
  // 보내도 입력칸의 초점이 유지된다(키보드가 닫히지 않는다)
  await pg.fill("#msg", "다음 질문");
  await pg.click("#send-btn");
  await pg.waitForFunction(() => window.__log.includes("aiRequest"));
  assert.equal(await pg.evaluate(() => document.activeElement && document.activeElement.id), "msg");
  st.releaseChat?.();
  assert.deepEqual(errors, []);
});

test("학생(휴대폰): 대화 시작 전(처음 내 생각·예시 질문이 보일 때)에도, 다른 단계에서도 화면이 휴대폰 폭보다 넓어지지 않는다", async () => {
  const st = studentFixture();
  st.caseExtra = { ui: { letterSign: "x", requiredWho: "x", requiredTag: "x", compareWith: "x", afterSince: "x", casesKinds: "x",
    priorQuestion: "우리가 분리배출한 플라스틱 병이나 비닐은 그 뒤에 어디로 가서 어떻게 된다고 생각했나요?", priorHint: "예) 공장에서 다 녹여서 새 물건이 되는 줄 알았다 / 생각해 본 적 없다" } };
  const { pg, errors } = await openStudent(st, { page: "m.html", ctxOpts: phone, chat: [] });
  await login(pg);
  await pg.waitForSelector(".card.prior");
  const width = () => pg.evaluate(() => ({ page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), main: Math.round(document.querySelector("#main").getBoundingClientRect().width), vw: innerWidth }));
  let w = await width();
  assert.ok(w.page <= w.vw + 1 && w.main <= w.vw, `대화 시작 전 화면 폭 ${JSON.stringify(w)}`);
  assert.ok(await pg.locator(".starters").isVisible(), "예시 질문 줄은 그대로 보인다(그 줄 안에서만 옆으로 넘긴다)");
  for (const n of [2, 3, 4, 5, 6, 7]) {
    await pg.click(`.m-nav .stage-tab:nth-child(${n})`).catch(() => {});
    await pg.waitForTimeout(150);
    w = await width();
    assert.ok(w.page <= w.vw + 1, `${n}단계 화면 폭 ${JSON.stringify(w)}`);
  }
  assert.deepEqual(errors, []);
});

test("학생(휴대폰): 말풍선은 바뀐 곳부터만 다시 그린다(앞쪽 말풍선 DOM 은 그대로)", async () => {
  const st = studentFixture(), { pg } = await openStudent(st, { page: "m.html", ctxOpts: phone, chat: [{ id: "c1", input: "안녕", output: "네" }] });
  await login(pg);
  await pg.waitForSelector("#msgs .msg");
  await pg.evaluate(() => { document.querySelector("#msgs .msg").dataset.mark = "keep"; });
  await pg.evaluate(() => window.__push("sessions/ABC234/groups/g1", { work: { s1: {} }, picks: { p1: { uid: "anonX", nick: "가람" } } }));
  await pg.fill("#msg", "다음 질문");
  await pg.click("#send-btn");
  await pg.waitForSelector("#msgs .msg.typing");
  assert.equal(await pg.evaluate(() => document.querySelector("#msgs .msg").dataset.mark), "keep");
  st.releaseChat?.();
});
