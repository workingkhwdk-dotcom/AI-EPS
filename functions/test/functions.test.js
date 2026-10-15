// index.js 통합 테스트: firebase-admin, firebase-functions, OpenAI(fetch)를 메모리 가짜로 대체한다.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// ---------- 메모리 Firestore ----------
const store = new Map();
const TS = { toMillis: () => 1 };
const FV = { serverTimestamp: () => TS, increment: (n) => ({ __inc: n }) };
function applyUpdate(cur, data) {
  const out = { ...cur };
  for (const [k, v] of Object.entries(data)) out[k] = v && v.__inc !== undefined ? (out[k] || 0) + v.__inc : v;
  return out;
}
let autoId = 0;
const docRef = (path) => ({
  path,
  async get() { const d = store.get(path); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))), id: path.split("/").pop() }; },
  async set(d) { store.set(path, d); },
  async update(d) { store.set(path, applyUpdate(store.get(path) || {}, d)); },
  collection: (name) => collRef(`${path}/${name}`),
});
const collRef = (path) => ({
  doc: (id) => docRef(`${path}/${id || "auto" + ++autoId}`),
  async get() {
    const docs = [...store.entries()].filter(([k]) => k.startsWith(path + "/") && !k.slice(path.length + 1).includes("/"))
      .map(([k, v]) => ({ id: k.split("/").pop(), data: () => v }));
    return { docs };
  },
});
const firestore = () => ({
  doc: docRef,
  collection: collRef,
  batch: () => { const ops = []; return { set: (r, d) => ops.push(() => r.set(d)), async commit() { for (const o of ops) await o(); } }; },
  async runTransaction(fn) {
    const tx = { get: (r) => r.get(), set: (r, d) => r.set(d), update: (r, d) => r.update(d) };
    return fn(tx);
  },
});
firestore.FieldValue = FV;

// ---------- 모듈 가로채기 ----------
const fakes = {
  "firebase-admin": { initializeApp() {}, firestore, auth() {} },
  "firebase-functions/v2/https": {
    onCall: (_o, fn) => fn,
    HttpsError: class extends Error { constructor(code, msg) { super(msg); this.code = code; } },
  },
  "firebase-functions/params": {
    defineSecret: () => ({ value: () => "sk-test" }),
    defineString: (name, o) => ({ value: () => ({ TEACHER_EMAILS: "t@school.kr", ALLOW_UNVERIFIED_PERSONAS: "true", OPENAI_MODEL: "gpt-5-test" }[name] ?? o?.default ?? "") }),
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return fakes[req] || origLoad.call(this, req, ...rest); };

// OpenAI 가짜: 시스템 프롬프트로 호출 종류를 구분한다
let guardReply = '{"ok":true,"category":"ok","reason":"","fixed":""}';
let personaReply = "저는 아직도 불안해요 😟";
let scenarioEmptyFirst = 0;
const calls = [];
const kindOf = (sys) =>
  sys.includes("상위 감독자") ? "guard"
    : sys.includes("시뮬레이션 도우미") ? "scenario"
    : sys.includes("독립 검토자") ? "review"
    : sys.includes("검색 보조자") ? "verify"
    : sys.includes("메신저 대화") ? "persona" : "other";
global.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const kind = kindOf(body.messages[0].content);
  calls.push({ kind, body });
  if (kind === "scenario" && scenarioEmptyFirst > 0) {
    scenarioEmptyFirst--; // 추론에 한도를 다 써서 빈 답이 온 상황
    return { ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) };
  }
  const content = kind === "guard" ? guardReply
    : kind === "scenario" ? '{"scenarios":[{"title":"A","story":"s","mechanism":"m","unintended":["u"],"newProblems":["p"]},{"title":"B","story":"s","mechanism":"m","unintended":["u"],"newProblems":["p"]}]}'
    : kind === "persona" ? personaReply
    : kind === "review" ? "강점: 좋다\n약점: 비싸다\n질문: 누가 반대할까?"
    : "일반적인 설명입니다.";
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
};

const api = require("../index.js");
const teacher = { auth: { uid: "T1", token: { email: "t@school.kr" } } };
const student = (uid) => ({ auth: { uid, token: {} } });
let code;
const chatDocs = (uid) => [...store.entries()].filter(([k]) => k.startsWith(`sessions/${code}/members/${uid}/chat/`)).map(([, v]) => v);
const groupLogs = () => [...store.entries()].filter(([k]) => k.startsWith(`sessions/${code}/groups/g1/logs/`)).map(([, v]) => v);
const setWork = (work) => store.set(`sessions/${code}/groups/g1`, { ...store.get(`sessions/${code}/groups/g1`), work });

test("교사: 수업 만들기 → 코드와 모둠 문서 생성", async () => {
  const { code: c } = await api.createSession({ ...teacher, data: { groupCount: 2, eventId: "bogus" } });
  code = c;
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal(store.get(`sessions/${code}`).eventId, "jeju2018");
  assert.deepEqual(Object.keys(store.get(`sessions/${code}/groups/g2`)).sort(), ["aiCount", "guardCount", "memberCount", "name", "work"]);
});

test("Firestore config/teachers 에 이메일을 넣으면 재배포 없이 교사가 되고, 관리자는 항상 교사", async () => {
  const newTeacher = { auth: { uid: "T2", token: { email: "New.Teacher@School.kr" } } };
  await assert.rejects(api.createSession({ ...newTeacher, data: {} }), /교사/);
  store.set("config/teachers", { emails: ["new.teacher@school.kr"] });
  assert.match((await api.createSession({ ...newTeacher, data: { groupCount: 1 } })).code, /^[A-Z2-9]{6}$/);
  store.delete("config/teachers");
  await assert.rejects(api.createSession({ ...newTeacher, data: {} }), /교사/);
  const admin = { auth: { uid: "A1", token: { email: "working.khwdk@gmail.com" } } };
  assert.match((await api.createSession({ ...admin, data: { groupCount: 1 } })).code, /^[A-Z2-9]{6}$/);
});

test("교사가 아니면 수업을 만들 수 없다", async () => {
  await assert.rejects(api.createSession({ ...student("S0"), data: {} }), /교사/);
});

test("입장: 같은 모둠의 학생들에게 서로 다른 인물이 배정되고(교사 기록에만), 재입장해도 유지된다", async () => {
  for (const [i, uid] of ["S1", "S2", "S3", "S4", "S5"].entries()) {
    const r = await api.joinSession({ ...student(uid), data: { code, groupNo: 1, nickname: "별" + i } });
    assert.deepEqual(Object.keys(r), ["groupId"], "학생에게 인물 배정을 알려 주면 안 된다");
  }
  const ids = ["S1", "S2", "S3", "S4", "S5"].map((u) => store.get(`sessions/${code}/members/${u}`).personaId);
  assert.deepEqual(ids.slice(0, 4).sort(), ["j_applicant", "j_officer", "j_resident", "j_supporter"]);
  assert.equal(ids[4], ids[0]);
  const m = store.get(`sessions/${code}/members/S1`);
  assert.equal(m.stage, 1);
  assert.equal(m.aiCount, 0);
  assert.ok(m.lastSeen);
  await api.joinSession({ ...student("S2"), data: { code, groupNo: 1, nickname: "바뀐별" } });
  assert.equal(store.get(`sessions/${code}/members/S2`).personaId, ids[1]);
  assert.equal(store.get(`sessions/${code}/members/S2`).nickname, "바뀐별");
  assert.equal(store.get(`sessions/${code}/groups/g1`).memberCount, 5);
});

test("getCase(학생): 객관적 사건 개요, 내 인물의 이름·편지, 실제 자료만. 역할·근거·출처·다른 인물은 없다", async () => {
  const data = await api.getCase({ ...student("S1"), data: { code } });
  assert.equal(data.me.name, "아델");
  assert.ok(data.me.letter.length >= 3);
  assert.match(data.summary, /2018년/);
  assert.equal(data.stakeholders.length, 4);
  assert.ok(data.materials.length >= 5);
  assert.ok(data.cases.length >= 4 && data.cases[0].links[0].url.startsWith("https://"));
  assert.ok(data.aftermath.length >= 4);
  const json = JSON.stringify(data);
  const { PERSONAS } = require("../case");
  // 인물의 역할명(label)·ID·근거 진술·출처·검증 여부는 학생에게 새면 안 된다
  const { SOURCES } = require("../case");
  // 인물 근거 출처의 링크는 숨긴다(사례 카드·이후 전개의 링크는 학생이 직접 확인하도록 보여 준다)
  const personaUrls = [...new Set(PERSONAS.flatMap((p) => p.claims.map((c) => SOURCES[c[1]].url)))];
  const leaks = [...PERSONAS.map((p) => p.label), ...PERSONAS.map((p) => p.id), "otherPersonas", "claims", "verified", ...personaUrls, '"src"', "basis", "setting", "voice", "story", "views", "profile"];
  for (const leak of leaks) assert.equal(json.includes(leak), false, `누출: ${leak}`);
  await assert.rejects(api.getCase({ ...student("OUT"), data: { code } }), /참여자/);
});

test("getCase(교사): 인물별 역할·근거 진술·출처와 자료 전체(출처 ID 포함)", async () => {
  const data = await api.getCase({ ...teacher, data: { eventId: "jeju2018" } });
  assert.equal(data.personas.length, 4);
  assert.ok(data.personas[0].claims.length >= 8 && data.personas[0].basis && data.personas[0].label);
  assert.ok(data.materials.every((c) => c.items.every((i) => Array.isArray(i.src) && typeof i.verified === "boolean")));
  await assert.rejects(api.getCase({ ...student("S1"), data: { eventId: "jeju2018" } }), /교사/);
});

const ask = (uid, message = "불안한 이유가 뭐예요?") =>
  api.aiRequest({ ...student(uid), data: { code, stage: 1, type: "persona_chat", payload: { message } } });

test("1단계 대화: 사전 질문 없이 바로 가능하고, 학생별 저장소에 기록되며, 인물→감독자 순으로 호출된다", async () => {
  calls.length = 0;
  const r = await ask("S3");
  assert.equal(r.result, "저는 아직도 불안해요 😟");
  assert.deepEqual(calls.map((c) => c.kind), ["persona", "guard"]);
  const docs = chatDocs("S3");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].input, "불안한 이유가 뭐예요?");
  assert.equal(docs[0].guard.ok, true);
  assert.equal(docs[0].personaId, store.get(`sessions/${code}/members/S3`).personaId);
  assert.equal(store.get(`sessions/${code}/members/S3`).aiCount, 1);
  assert.equal(store.get(`sessions/${code}/groups/g1`).aiCount, 1);
  assert.equal(groupLogs().length, 0, "1단계 대화는 모둠 로그에 섞이지 않는다");
});

test("1단계 대화: 클라이언트가 인물을 지정해도 서버는 배정된 인물만 쓰고, 이전 대화를 이어서 전달한다", async () => {
  calls.length = 0;
  await api.aiRequest({ ...student("S3"), data: { code, stage: 1, type: "persona_chat", payload: { message: "두번째 질문", personaId: "j_officer" } } });
  const personaCall = calls.find((c) => c.kind === "persona");
  const mine = store.get(`sessions/${code}/members/S3`).personaId;
  const { PERSONAS } = require("../case");
  const name = PERSONAS.find((p) => p.id === mine).name;
  assert.ok(personaCall.body.messages[0].content.includes(`'${name}'`));
  // 시스템 + (이전 질문, 이전 답) + 새 질문
  assert.equal(personaCall.body.messages.length, 4);
  assert.equal(personaCall.body.messages[1].content, "불안한 이유가 뭐예요?");
  assert.equal(personaCall.body.messages[3].content, "두번째 질문");
  assert.equal(chatDocs("S3").length, 2);
});

test("다른 학생의 대화 기록과 섞이지 않는다", async () => {
  await ask("S4", "S4의 첫 질문");
  assert.equal(chatDocs("S4").length, 1);
  assert.equal(chatDocs("S3").length, 2);
});

test("빈 메시지는 거부된다", async () => {
  await assert.rejects(ask("S3", "   "), /메시지/);
});

test("상위 AI 감독: 가벼운 위반(묻지 않은 정보)은 같은 인물 말투로 고쳐 쓰고 원문은 교사 기록에만 남긴다", async () => {
  guardReply = '{"ok":false,"category":"overshare","reason":"묻지 않은 정보","fixed":"음, 그건 잘 기억이 안 나요 🙂"}';
  const r = await ask("S3", "언제 오셨어요?");
  assert.equal(r.result, "음, 그건 잘 기억이 안 나요 🙂");
  const log = chatDocs("S3").pop();
  assert.equal(log.output, "음, 그건 잘 기억이 안 나요 🙂");
  assert.equal(log.guard.how, "fixed");
  assert.equal(log.guard.category, "overshare");
  assert.equal(log.guard.original, "저는 아직도 불안해요 😟");
  assert.equal(store.get(`sessions/${code}/groups/g1`).guardCount, 1);
});

test("상위 AI 감독: 범위 이탈은 인물 말투의 안내로 대체한다", async () => {
  guardReply = '{"ok":false,"category":"scope","reason":"다른 난민 사건","fixed":""}';
  const r = await ask("S3", "시리아 난민은 어떻게 됐어요?");
  assert.match(r.result, /잘 아는 얘기가 아니에요/);
  assert.doesNotMatch(r.result, /AI|수업|자료/);
  const log = chatDocs("S3").pop();
  assert.equal(log.guard.how, "fallback");
  assert.equal(store.get(`sessions/${code}/groups/g1`).guardCount, 2);
});

test("상위 AI 감독: 감독자 응답이 깨지면 안전 쪽(안내)으로 처리한다", async () => {
  guardReply = "이건 JSON이 아님";
  const r = await ask("S3");
  assert.match(r.result, /말이 잘 안 나오네요/);
  guardReply = '{"ok":true,"category":"ok","reason":"","fixed":""}';
});

test("3단계: 2단계에서 만든 검증 질문(들은 이야기+질문)만 AI에게 물을 수 있다", async () => {
  setWork({ s2: { checks: { c1: { heard: "일자리를 구하기 어렵대요", question: "예멘 신청자의 취업은 어떻게 제한되었나?", real: "자료: 5일 이내 단기 노무", t: 1 } } } });
  await assert.rejects(
    api.aiRequest({ ...student("S3"), data: { code, stage: 3, type: "verify_query", payload: { checkId: "없음" } } }), /검증 질문/);
  calls.length = 0;
  const r = await api.aiRequest({ ...student("S3"), data: { code, stage: 3, type: "verify_query", payload: { checkId: "c1" } } });
  assert.equal(r.result, "일반적인 설명입니다.");
  const userMsg = calls[0].body.messages[1].content;
  assert.match(userMsg, /일자리를 구하기 어렵대요/);
  assert.match(userMsg, /예멘 신청자의 취업은 어떻게 제한되었나/);
  assert.equal(groupLogs().filter((l) => l.stage === 3).length, 1);
  assert.equal(groupLogs().find((l) => l.stage === 3).payload.checkId, "c1");
});

test("4단계: 서로 다른 관점의 독립 검토 3개를 만든다", async () => {
  setWork({ s4: { proposals: { a1: { text: "가".repeat(40), t: 1 } } } });
  calls.length = 0;
  const r = await api.aiRequest({ ...student("S3"), data: { code, stage: 4, type: "proposal_feedback", payload: { proposalId: "a1" } } });
  assert.equal(r.result.reviews.length, 3);
  assert.deepEqual(r.result.reviews.map((x) => x.lens), ["feasibility", "stakeholders", "sideEffects"]);
  const sys = calls.filter((c) => c.kind === "review").map((c) => c.body.messages[0].content);
  assert.equal(sys.length, 3);
  assert.equal(new Set(sys).size, 3, "관점마다 프롬프트가 달라야 한다");
  const log = groupLogs().find((l) => l.stage === 4);
  assert.equal(JSON.parse(log.output).reviews.length, 3);
});

const sixWork = () => ({
  s4: { proposals: { a1: { text: "가".repeat(40), t: 1 } } },
  s5: { predictions: { p1: { stakeholder: "도민", text: "가".repeat(12), t: 1 }, p2: { stakeholder: "신청자", text: "나".repeat(12), t: 2 } } },
});

test("5단계 시뮬레이션: 첫 시도가 빈 답이면 사고량을 낮춰 다시 시도해 성공하고 작동 기제를 포함한다", async () => {
  setWork(sixWork());
  scenarioEmptyFirst = 1;
  calls.length = 0;
  const r = await api.aiRequest({ ...student("S3"), data: { code, stage: 5, type: "scenario", payload: { proposalId: "a1", round: 5 } } });
  assert.equal(r.result.scenarios.length, 2);
  assert.ok(r.result.scenarios[0].mechanism);
  const sc = calls.filter((c) => c.kind === "scenario");
  assert.equal(sc.length, 2);
  assert.equal(sc[0].body.reasoning_effort, "medium");
  assert.equal(sc[1].body.reasoning_effort, "low");
  assert.ok(sc[0].body.max_completion_tokens >= 8000);
});

test("5단계 시뮬레이션: 두 번 다 실패하면 오류를 돌려주고 원인을 모둠 문서에 남긴다", async () => {
  scenarioEmptyFirst = 2;
  await assert.rejects(
    api.aiRequest({ ...student("S3"), data: { code, stage: 5, type: "scenario", payload: { proposalId: "a1", round: 3 } } }),
    /AI 응답을 받지 못했습니다/,
  );
  const g = store.get(`sessions/${code}/groups/g1`);
  assert.equal(g.lastAiError.stage, 5);
  assert.match(g.lastAiError.message, /빈 응답/);
  scenarioEmptyFirst = 0;
});

test("선행 사고가 없으면 4·5단계 AI는 열리지 않고, 2·6·7단계는 항상 닫혀 있다", async () => {
  setWork({});
  await assert.rejects(api.aiRequest({ ...student("S3"), data: { code, stage: 4, type: "proposal_feedback", payload: { proposalId: "a1" } } }), /대안/);
  await assert.rejects(api.aiRequest({ ...student("S3"), data: { code, stage: 2, type: "persona_chat", payload: { message: "x" } } }), /스스로/);
});

const alerts = () => [...store.entries()].filter(([k]) => k.startsWith(`sessions/${code}/alerts/`)).map(([, v]) => v);

test("5단계: 4단계 최종 대안(final)을 시뮬레이션할 수 있고, 짧으면 막힌다", async () => {
  setWork({ ...sixWork(), s4: { ...sixWork().s4, final: "최종 대안: 제주 지역 주민과 함께하는 한국어·일자리 연계 프로그램을 만든다." } });
  calls.length = 0;
  const r = await api.aiRequest({ ...student("S3"), data: { code, stage: 5, type: "scenario", payload: { proposalId: "final", round: 1 } } });
  assert.equal(r.result.scenarios.length, 2);
  assert.match(calls.find((c) => c.kind === "scenario").body.messages[1].content, /한국어·일자리 연계/);
  setWork({ ...sixWork(), s4: { ...sixWork().s4, final: "짧음" } });
  await assert.rejects(api.aiRequest({ ...student("S3"), data: { code, stage: 5, type: "scenario", payload: { proposalId: "final", round: 1 } } }), /최종 대안/);
});

test("1단계: 인물의 나이·성별 같은 신상 질문은 그대로 대화한다(제재 없음)", async () => {
  calls.length = 0;
  const r = await ask("S3", "몇 살이야? 성별은?");
  assert.equal(r.conduct, null);
  assert.deepEqual(calls.map((c) => c.kind), ["persona", "guard"]);
  assert.equal(alerts().length, 0);
});

test("1단계: 명백한 성적 희롱은 인물 응답을 만들지 않고 선을 긋고, 경고·교사 신호를 남긴다", async () => {
  calls.length = 0;
  const r = await ask("S3", "섹 스 해봤어?");
  assert.deepEqual(calls.map((c) => c.kind), []);
  assert.match(r.result, /답하지 않을게요/);
  assert.equal(r.conduct.category, "sexual");
  assert.equal(r.conduct.strikes, 1);
  assert.match(r.conduct.notice, /경고 1\/3/);
  const m = store.get(`sessions/${code}/members/S3`);
  assert.equal(m.conduct.strikes, 1);
  assert.equal(m.chatLocked, undefined);
  const a = alerts();
  assert.equal(a.length, 1);
  assert.equal(a[0].category, "sexual");
  assert.equal(a[0].input, "섹 스 해봤어?");
  assert.equal(store.get(`sessions/${code}/groups/g1`).conductCount, 1);
});

test("1단계: 규칙에 안 걸린 조롱도 감독자가 판정하면 제재하고, 원래 인물 응답은 교사 기록에만 남는다", async () => {
  guardReply = '{"ok":true,"category":"ok","reason":"","fixed":"","conduct":"mockery"}';
  const r = await ask("S3", "너 같은 사람은 여기 오면 안 되지 ㅋㅋ");
  guardReply = '{"ok":true,"category":"ok","reason":"","fixed":"","conduct":"ok"}';
  assert.match(r.result, /상처받아요/);
  assert.equal(r.conduct.by, "guard");
  assert.equal(r.conduct.strikes, 2);
  const last = chatDocs("S3").find((d) => d.input.startsWith("너 같은"));
  assert.equal(last.guard.how, "conduct");
  assert.equal(last.guard.original, "저는 아직도 불안해요 😟");
});

test("1단계: 경고 3번이면 대화가 멈추고, 교사만 다시 열 수 있다", async () => {
  const r = await ask("S3", "야 이 난민 새끼야");
  assert.equal(r.conduct.locked, true);
  assert.equal(store.get(`sessions/${code}/members/S3`).chatLocked, true);
  await assert.rejects(ask("S3", "다시 이야기해요"), /대화가 멈췄어요/);
  await assert.rejects(api.unlockChat({ ...student("S3"), data: { code, uid: "S3" } }), /교사/);
  await api.unlockChat({ ...teacher, data: { code, uid: "S3" } });
  const m = store.get(`sessions/${code}/members/S3`);
  assert.equal(m.chatLocked, false);
  assert.equal(m.conduct.strikes, 0);
  assert.equal(m.conduct.total, 3);
  const r2 = await ask("S3", "아까는 미안해요");
  assert.equal(r2.conduct, null);
});
