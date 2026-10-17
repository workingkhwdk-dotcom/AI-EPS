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
    export const signInWithRedirect = async () => {};`,
  "firebase-firestore.js": `
    const isDoc = (p) => p.split("/").length % 2 === 0;
    export const getFirestore = () => ({});
    export const doc = (_d, p) => ({ p }); export const collection = (_d, p) => ({ p });
    export const query = (c) => c; export const where = () => 0; export const orderBy = () => 0;
    export const serverTimestamp = () => 0; export const deleteField = () => ({ del: 1 });
    export const getDoc = async (r) => (window.__docs[r.p] ? { exists: () => true, data: () => window.__docs[r.p] } : { exists: () => false });
    export const getDocs = async (r) => ({ docs: (window.__cols[r.p] || []).map((d) => ({ id: d.id, data: () => d })) });
    export const updateDoc = async (r, data) => { window.__writes.push(data); if (window.__hangWrites) await new Promise(() => {}); };
    export const onSnapshot = (r, cb) => {
      setTimeout(() => (isDoc(r.p) ? cb({ exists: () => r.p in window.__docs, data: () => window.__docs[r.p] || {} }) : cb({ docs: (window.__cols[r.p] || []).map((d) => ({ id: d.id, data: () => d })) })), 0);
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
    res.writeHead(200, { "Content-Type": f.endsWith(".webp") ? "image/webp" : (f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html") + "; charset=utf-8" });
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
  await pg.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ contentType: "text/javascript", body: stubs[r.request().url().split("/").pop()] || "" }));
  await pg.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
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
async function openTeacher(st, { page = "teacher.html", ctxOpts } = {}) {
  const t = await newPage(() => {
    window.__user = { uid: "T1", email: "t@x.kr", isAnonymous: false };
    window.__docs = {};
    window.__cols = {
      sessions: [{ id: "ABC234", title: "테스트 수업", groupCount: 3, teacherUid: "T1" }],
      "sessions/ABC234/members": [{ id: "u1", groupId: "g1", nickname: "가람", stage: 2 }, { id: "u2", groupId: "g1", nickname: "나래", stage: 2 }],
      "sessions/ABC234/groups": [{ id: "g1", name: "1모둠", work: {}, lastAiError: { stage: 3, message: "시간 초과" }, aiCount: 130, guardCount: 4 }],
    };
  }, st.handler, undefined, ctxOpts);
  await t.pg.goto(`${base}/${page}`);
  await t.pg.waitForSelector("#sessions button[data-code]");
  await t.pg.click("#sessions button[data-code]");
  return t;
}

test("교사: 수업 목록 → 수업 열기 → 알림·학생 표", async () => {
  const st = teacherFixture(), { pg, errors } = await openTeacher(st);
  assert.ok(await pg.locator("#class-view").isVisible());
  assert.ok(!(await pg.locator("#class-list-view").isVisible()));
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
  pg.once("dialog", (d) => d.accept("2"));
  await pg.locator('[data-move="u1"]').click();
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
  const st = { joined: [], chatCalls: [], releaseChat: null, failNext: false, calls: [] };
  st.handler = async (name, data) => {
    st.calls.push(name);
    if (name === "joinSession") { st.joined.push(data); if (data.password !== "pw1234") throw new Error("functions: 비밀번호가 맞지 않습니다."); return { groupId: "g1" }; }
    if (name === "getCase") return { title: "제목", summary: "요약", stakeholders: [], me: { name: "김씨", letter: ["안녕하세요"] }, materials: [] };
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
async function openStudent(st, { member = {}, work = {}, session = { chatLimit: 5 }, page = "index.html", ctxOpts } = {}) {
  const s = await newPage(({ member, work, session }) => {
    window.__user = null; window.__anonUid = "anonX";
    window.__docs = { "sessions/ABC234": session, "sessions/ABC234/members/anonX": { groupId: "g1", nickname: "가람", ...member }, "sessions/ABC234/groups/g1": { work } };
    window.__cols = { "sessions/ABC234/members/anonX/chat": [{ id: "c1", input: "안녕하세요", output: "네, 안녕하세요", model: "m" }] };
  }, st.handler, { member, work, session }, ctxOpts);
  await s.pg.goto(`${base}/${page}`);
  await s.pg.waitForSelector("#j-pw");
  return s;
}
async function login(pg) {
  await pg.fill("#j-code", "abc234"); await pg.fill("#j-group", "1"); await pg.fill("#j-nick", "가람"); await pg.fill("#j-pw", "pw1234");
  await pg.click("#j-btn");
  await pg.waitForSelector("#app:not(.hidden)");
}

test("학생: 입장 폼 — 빈 칸이면 요청하지 않고, 틀린 비밀번호는 실패, 맞으면 입장하며 로그아웃 버튼이 생긴다", async () => {
  const st = studentFixture(), { pg, errors } = await openStudent(st);
  assert.ok(!(await pg.locator("#logout").isVisible()));
  await pg.fill("#j-code", "abc234"); await pg.fill("#j-group", "1"); await pg.fill("#j-nick", "가람");
  await pg.click("#j-btn");
  assert.equal(st.joined.length, 0);
  await pg.fill("#j-pw", "bad"); await pg.click("#j-btn");
  await pg.waitForFunction(() => window.__log.includes("joinSession"));
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
  const nav = pg.waitForNavigation();
  await pg.click("#logout"); await nav;
  await pg.waitForSelector("#j-pw");
  assert.equal(await pg.evaluate(() => sessionStorage.getItem("eps_code")), null);
  assert.ok(await pg.locator("#join").isVisible());
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
  assert.match(await s1.pg.locator("#panel").innerText(), /핵심 원인을 먼저 정해야/);
  await s1.pg.click('.stage-tab[data-stage="5"]');
  await s1.pg.waitForFunction(() => /최종 대안을 30자 이상 먼저 써야/.test(document.querySelector("#panel").innerText));
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
  assert.match(await pg.locator("#students").innerText(), /0 \/ 5번/);
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
  assert.match(await s.pg.locator("#panel").innerText(), /검증 질문 확인하기/);
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
