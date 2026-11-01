// 지도안 부록 1용 '평가' 화면 촬영: 교사 화면(태블릿, t-teacher.html)의 평가 탭을 가짜 서버와 시연 데이터로 열어 단계별로 찍는다.
// 척도표·학생 글(근거)은 앱 코드(functions/rubric.js, assess.js)와 시연 데이터(seed.js)에서 그대로 만들고, AI 판정·세특 초안은 시연용 예시다.
// node capa.js → shots/a-*.jpg (확인 후 img/ 로 옮겨 build.js 가 쓴다)
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const seed = require("./seed.js");
const REPO = path.resolve(__dirname, "../..");
const R = require(path.join(REPO, "functions/rubric.js"));
const A = require(path.join(REPO, "functions/assess.js"));
const SK = require(path.join(REPO, "functions/seteuk.js"));
const src = fs.readFileSync(path.join(__dirname, "cap.js"), "utf8");
const stubs = eval("(" + src.match(/const stubs = (\{[\s\S]*?\n\});/)[1] + ")");
const ROOT = path.join(REPO, "public"), OUT = path.join(__dirname, "shots"), FONTS = path.join(__dirname, "fonts/node_modules");
const types = { ".webp": "image/webp", ".png": "image/png", ".ico": "image/x-icon", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u.startsWith("/__f/")) { const f = path.join(FONTS, u.slice(5)); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": "font/woff2", "Access-Control-Allow-Origin": "*" }); return res.end(fs.readFileSync(f)); }
  const f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[path.extname(f)] || "text/html; charset=utf-8" }); res.end(fs.readFileSync(f));
});
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DEEP = Object.fromEntries(["beliefs", "premise", "causeMap", "sources", "tradeoff", "chain", "power", "why"].map((k) => [k, true]));

// ---------- 시연 데이터 ----------
const rubric = R.rubricFor("high", DEEP, { contrib: true });
const names = ["가람", "나래", "다온", "라온", "마루", "바다", "사랑", "아름", "하늘", "새봄", "도윤", "서윤", "지우", "예준", "시우", "하린", "지안", "유나", "로운", "소율", "다인", "이든", "나비", "보리"];
const code4 = (i) => `S-${(0x3a1f + i * 2711).toString(16).slice(-4).toUpperCase()}`;
const nG = rubric.criteria.filter((c) => c.scope === "group").length, nS = rubric.criteria.filter((c) => c.scope === "student").length;
const aiG = rubric.criteria.filter((c) => c.scope === "group" && c.ai).length, aiS = rubric.criteria.filter((c) => c.scope === "student" && c.ai).length;
const groups = Array.from({ length: 6 }, (_, i) => ({ id: `g${i + 1}`, name: `${i + 1}모둠`, members: 4, scored: i === 0 ? 5 : 6, total: nG, ai: aiG, unreviewed: 4, exc: i === 0 ? 1 : i === 3 ? 1 : 0, calibSample: false }));
const students = names.map((nick, i) => ({ key: `k${i + 1}`, nick, code: code4(i), groupId: `g${Math.floor(i / 4) + 1}`, scored: i === 5 ? 0 : i % 5 === 1 ? 6 : 7, total: nS, ai: aiS, unreviewed: 5, exc: i % 5 === 1 ? 1 : 0, appeals: 0,
  calibSample: false, hasSeteuk: i >= 6 && i < 14, hasDraft: i < 6 && i !== 5 || i >= 14, excluded: i === 5 ? { reason: "absent", label: "결석", note: "인정결석(병결)" } : null }));
const live = students.filter((x) => !x.excluded);
const done = groups.reduce((n, g) => n + g.scored, 0) + live.reduce((n, x) => n + x.scored, 0), total = groups.length * nG + live.length * nS;
const get = { rubric, groups, students, progress: { done, total, reviewCount: 0, unreviewed: 4 * 6 + 5 * live.length - 30 }, mode: "ai_first", auto: { on: true, calib: false }, autoPaused: false, audit: { n: 0, exact: null, paused: false },
  queue: { exceptions: 7, appeals: 1, observation: 23 }, calib: null, aiTotal: { group: aiG, student: aiS }, release: { score: false, seteuk: false }, seteukMax: 1500, seteukRange: [300, 3000], aiUsed: 412, aiCap: 1500, aiRuns: 3,
  thresholds: A.THRESHOLDS, contrib: true, appealUntil: new Date(2026, 10, 20, 17, 0).getTime(), job: { type: "score", status: "done", total: 29, done: 29, failed: 0, current: [], fails: [], summary: { applied: 238, exceptions: 7 } } };

// 근거: 앱의 evidenceFor 로 시연 모둠 산출물(seed.work)에서 그대로 만든다
const mem = [{ uid: "anonX", nick: "가람" }, { uid: "u2", nick: "나래" }, { uid: "u3", nick: "다온" }, { uid: "u4", nick: "라온" }];
const ctxG = { work: seed.work, logs3: (seed.logs || []).filter((l) => l.stage === 3), deep: DEEP, groupAi: 18, members: mem };
const ctxS = { ...ctxG, student: { uid: "anonX", nick: "가람", chat: (seed.chat || []).slice(0, 5), chatCount: 5, coachCount: 1 } };
const evid = (kind) => Object.fromEntries(rubric.criteria.filter((c) => c.scope === (kind === "group" ? "group" : "student")).map((c) => [c.id, A.evidenceFor(c.id, kind === "group" ? ctxG : ctxS)]));
const evG = evid("group"), evS = evid("student");
const aiRec = (level, reason, quote) => ({ level, levels: [level, level, level], spread: 0, quote, quoteOk: true, reason, n: 3 });
const first = (ev, n = 26) => (ev?.find((e) => !A.isRefLabel(e.label))?.text || "").slice(0, n);
const subjG = { kind: "group", id: "g1", mode: "ai_first", calibSample: false, evidence: evG, empty: Object.fromEntries(Object.keys(evG).map((k) => [k, A.evidenceEmpty(evG[k])])),
  scores: { c23: { level: 1, pts: 4, note: "AI 제안: 판정마다 자료를 들었으나 가장 큰 원인으로 잇는 설명이 짧음", src: "ai", reviewed: false }, c32: { level: 1, pts: 4, note: "AI 제안: 약점을 따졌으나 불이익을 받는 사람 검토가 부분적임", src: "ai", reviewed: false } },
  ai: { c12: aiRec(1, "같은 점·부딪히는 점을 구별했으나 점검표 확인의 근거가 짧음", first(evG.c12)), c23: aiRec(1, "판정마다 자료를 들었으나 가장 큰 원인으로 잇는 설명이 짧음", first(evG.c23)), c32: aiRec(1, "약점을 따졌으나 불이익을 받는 사람 검토가 부분적임", first(evG.c32)) },
  hasAi: Object.fromEntries(Object.keys(evG).map((k) => [k, true])), review: {}, seteuk: null, excluded: null };
const reasons = ["AI가 세 번 채점했는데 결과가 달랐어요", "가장 높거나 낮은 수준이라 선생님이 확인해요"];
const c12 = rubric.criteria.find((c) => c.id === "c12"), c63 = rubric.criteria.find((c) => c.id === "c63");
const queue = { total: 8, offset: 0, appeals: 1, items: [
  { type: "exception", kind: "group", id: "g1", via: null, cid: "c12", name: c12.name, el: c12.elName, code: "1모둠", nick: null, groupId: "g1", reasons, appeal: null, evidence: evG.c12.slice(0, 4), empty: false,
    ai: { level: 0, levels: [0, 1, 0], spread: 1, quote: first(evG.c12, 30), quoteOk: true, reason: "세 가지를 구별하고 두 바람을 담은 질문을 씀", n: 3, esc: true }, score: null, levels: c12.levels, max: c12.max },
  { type: "exception", kind: "student", id: "k1", via: null, cid: "c63", name: c63.name, el: c63.elName, code: code4(0), nick: "가람", groupId: "g1", reasons: [reasons[0]], appeal: null, evidence: evS.c63.slice(0, 5), empty: false,
    ai: { level: 1, levels: [0, 1, 1], spread: 1, quote: first(evS.c63, 30), quoteOk: true, reason: "구체적인 정리를 보냈고 모둠 질문에 일부 쓰임", n: 3 }, score: null, levels: c63.levels, max: c63.max },
] };
const draftText = "제주 예멘 난민 사건의 당사자 인물과 인터뷰하며 '살려고 왔다'는 말에서 처음 생각이 흔들린 순간을 정리하고, '심사만 받으면 대부분 인정된다'는 말을 확인 질문으로 바꾸어 탐구를 시작함. 이를 바탕으로 원인을 사람들의 생각과 제도로 나누어 추측하고, 실제 사건 자료의 심사 결과를 근거로 판정하여 대부분이 인도적 체류에 그쳤다는 사실을 밝혀냄. 그러나 인도적 체류자가 교육·의료 지원을 받지 못한다는 자료를 비교하면서, 정착을 가로막는 핵심 원인이 제도 이해의 부족에 있다고 보는 관점으로 생각을 넓힘. 이러한 탐구를 통해 처음의 막연한 인상을 자료로 검증하는 태도를 기르고, 제도 설명회와 한국어 지원을 묶은 해결책을 모둠과 함께 제안함.";
const draft = { text: draftText, bytes: SK.neisBytes(draftText), warnings: [], parts: [], dropped: [], log: [{ n: 1, bytes: 1386 }, { n: 2, bytes: 1442 }], target: 1500, calls: 3, grade: "A", emphasis: "academic", decision: "keep", evidence: {}, t: 2 };
const subjS = { kind: "student", id: "k1", mode: "ai_first", calibSample: false, evidence: evS, empty: Object.fromEntries(Object.keys(evS).map((k) => [k, A.evidenceEmpty(evS[k])])), scores: {}, ai: {}, hasAi: {}, review: {},
  seteuk: { text: "", t: 0, draft }, excluded: null };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ userAgent: IPAD, viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2, hasTouch: true, locale: "ko-KR" });
  const pg = await ctx.newPage(); const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ contentType: "text/javascript", body: stubs[r.request().url().split("/").pop()] || "" }));
  await pg.route(/cdn\.jsdelivr/, (r) => r.fulfill({ contentType: "text/css", body: `@font-face{font-family:'Pretendard Variable';font-weight:45 920;font-style:normal;src:url(${base}/__f/pretendard/dist/web/variable/woff2/PretendardVariable.woff2) format('woff2-variations');}` }));
  await pg.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  await pg.addInitScript(({ DEEP, get, subjG, subjS, queue }) => {
    try { for (const k of ["teacher-main", "teacher-class", "demo-menu", "demo-play"]) localStorage.setItem("eps_tour_" + k, "1"); } catch {}
    window.__user = { uid: "T1", email: "t@x.kr", isAnonymous: false };
    window.__docs = {};
    window.__cols = {
      sessions: [{ id: "ABC234", title: "제주 예멘 난민 사건, 갈등 해결 방안 제안하기", groupCount: 6, teacherUid: "T1", level: "high", deep: DEEP, contrib: true, started: true, chatLimit: 5, aiLimit: 150, coach: true, eventId: "jeju2018" }],
      "sessions/ABC234/members": [], "sessions/ABC234/alerts": [], "sessions/ABC234/groups": [],
    };
    window.__log = []; window.__writes = [];
    window.__fn = async (name, d) => {
      if (name === "assess") {
        if (d.action === "get") return get;
        if (d.action === "subject") return d.kind === "group" ? subjG : subjS;
        if (d.action === "queue") return queue;
        if (d.action === "job") return { job: get.job };
      }
      if (name === "getMaterials") return { categories: [], isDefault: true };
      if (name === "getCase") return { personas: [], materials: [], event: { teacherNote: "", background: [] } };
      return {};
    };
  }, { DEEP, get, subjG, subjS, queue });
  const shot = async (name, sel, dy = 0) => {
    await pg.evaluate(([s, dy]) => window.scrollTo(0, document.querySelector(s).getBoundingClientRect().top + scrollY - 120 + dy), [sel, dy]);
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: path.join(OUT, name + ".jpg"), type: "jpeg", quality: 88 }); console.log(name);
  };
  await pg.goto(`${base}/t-teacher.html`);
  await pg.waitForSelector("#sessions button[data-code]");
  await pg.click("#sessions button[data-code]");
  await pg.click('[data-ctab="assess"]');
  await pg.waitForSelector("#as-views");
  // ① 채점: AI 채점을 마친 뒤, 모둠별 점수와 항목 카드
  await pg.click('#as-views [data-asv="score"]');
  await pg.click('.as-pick [data-asid="g1"]'); await pg.waitForSelector('.as-crit[data-cid="c23"]');
  await shot("a-1-score", ".as-head");
  // ② 확인: 할 일 세 줄과 직접 정할 점수
  await pg.click('#as-views [data-asv="queue"]'); await pg.waitForSelector(".q-card");
  await shot("a-2-check", ".as-head");
  // ③ 세특: 서버가 한꺼번에 만든 초안을 열어 읽는 화면
  await pg.click('#as-views [data-asv="seteuk"]'); await pg.waitForSelector("#as-seteuk");
  await shot("a-3-seteuk", ".as-head");
  // ④ 공개: 남은 것 확인, 이의 신청 마감, 미리보기, NEIS에 옮기기
  await pg.click('#as-views [data-asv="release"]'); await pg.waitForSelector(".as-deadline");
  await shot("a-4-release", ".as-head");
  console.log("errors", errors);
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
