// index.js 통합 테스트: firebase-admin, firebase-functions, OpenAI(fetch)를 메모리 가짜로 대체한다.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// ---------- 메모리 Firestore ----------
const store = new Map();
const TS = { toMillis: () => 1 };
const DEL = { __del: true };
const FV = { serverTimestamp: () => TS, increment: (n) => ({ __inc: n }), delete: () => DEL };
// 점(.)이 든 필드 경로는 중첩 객체로 풀어서 갱신하고, FieldValue.delete() 는 그 키를 지운다
function applyUpdate(cur, data) {
  const out = JSON.parse(JSON.stringify(cur));
  for (const [k, v] of Object.entries(data)) {
    const keys = k.split(".");
    let o = out;
    for (const kk of keys.slice(0, -1)) { if (o[kk] == null || typeof o[kk] !== "object") o[kk] = {}; o = o[kk]; }
    const last = keys[keys.length - 1];
    if (v && v.__del) delete o[last];
    else o[last] = v && v.__inc !== undefined ? (o[last] || 0) + v.__inc : v;
  }
  return out;
}
let autoId = 0;
const docRef = (path) => ({
  path,
  async get() { const d = store.get(path); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))), id: path.split("/").pop() }; },
  async set(d) { store.set(path, d); },
  async update(d) { store.set(path, applyUpdate(store.get(path) || {}, d)); },
  async delete() { store.delete(path); },
  collection: (name) => collRef(`${path}/${name}`),
});
const collRef = (path, filters = []) => ({
  doc: (id) => docRef(`${path}/${id || "auto" + ++autoId}`),
  where: (f, _op, val) => collRef(path, [...filters, [f, val]]),
  async get() {
    const docs = [...store.entries()].filter(([k]) => k.startsWith(path + "/") && !k.slice(path.length + 1).includes("/"))
      .filter(([, v]) => filters.every(([f, val]) => v[f] === val))
      .map(([k, v]) => ({ id: k.split("/").pop(), data: () => JSON.parse(JSON.stringify(v)) }));
    return { docs };
  },
});
const firestore = () => ({
  doc: docRef,
  collection: collRef,
  batch: () => {
    const ops = [];
    return {
      set: (r, d) => ops.push(() => r.set(d)), update: (r, d) => ops.push(() => r.update(d)), delete: (r) => ops.push(() => r.delete()),
      async commit() { for (const o of ops) await o(); },
    };
  },
  async recursiveDelete(r) { for (const k of [...store.keys()]) if (k === r.path || k.startsWith(r.path + "/")) store.delete(k); },
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
let searchReply = "NOT_FOUND"; // 웹 검색 가짜의 답
let searchSources = [];
let personaToolCalls = 0; // 인물이 lookup 도구를 부르는 횟수(남은 횟수)
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).endsWith("/v1/responses")) {
    calls.push({ kind: "search", body });
    return { ok: true, json: async () => ({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: searchReply, annotations: searchSources.map((u) => ({ type: "url_citation", url: u, title: "기사 " + u })) }] }] }) };
  }
  const kind = kindOf(body.messages[0].content);
  calls.push({ kind, body });
  if (kind === "scenario" && scenarioEmptyFirst > 0) {
    scenarioEmptyFirst--; // 추론에 한도를 다 써서 빈 답이 온 상황
    return { ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) };
  }
  if (kind === "persona" && personaToolCalls > 0 && body.tools?.length) {
    personaToolCalls--;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call" + personaToolCalls, type: "function", function: { name: "lookup", arguments: JSON.stringify({ query: "인도적 체류 허가를 받은 예멘인 수" }) } }] } }] }) };
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
const pidOf = (c, uid) => store.get(`sessions/${c}/assign/${uid}`)?.personaId;
const glogs = (uid) => [...store.entries()].filter(([k, v]) => k.startsWith(`sessions/${code}/guardlog/`) && v.uid === uid).map(([, v]) => v);
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

test("입장: 같은 모둠 학생들에게 축(당사자·도민·시민사회·제도)이 겹치지 않게 서로 다른 인물이 무작위 배정되고(교사 기록에만), 재입장해도 유지된다", async () => {
  for (const [i, uid] of ["S1", "S2", "S3", "S4", "S5"].entries()) {
    const r = await api.joinSession({ ...student(uid), data: { code, groupNo: 1, nickname: "별" + i, password: "pw" + i + "99" } });
    assert.deepEqual(Object.keys(r), ["groupId"], "학생에게 인물 배정을 알려 주면 안 된다");
  }
  const { PERSONAS } = require("../case");
  const ids = ["S1", "S2", "S3", "S4", "S5"].map((u) => pidOf(code, u));
  const axisOf = (id) => PERSONAS.find((p) => p.id === id).axis;
  assert.deepEqual(ids.slice(0, 4).map(axisOf).sort(), ["당사자", "도민", "시민사회", "제도"]);
  assert.equal(new Set(ids).size, 5, "다섯 명 모두 다른 인물");
  assert.deepEqual(store.get(`sessions/${code}/assignGroup/g1`).personaIds, ids);
  // 학생이 읽는 문서(학생 문서, 모둠 문서)에는 인물 정보가 없다
  assert.equal("personaId" in store.get(`sessions/${code}/members/S1`), false);
  assert.equal("personaIds" in store.get(`sessions/${code}/groups/g1`), false);
  const m = store.get(`sessions/${code}/members/S1`);
  assert.equal(m.stage, 1);
  assert.equal(m.aiCount, 0);
  assert.ok(m.lastSeen);
  await api.joinSession({ ...student("S2"), data: { code, groupNo: 1, nickname: "별1", password: "pw199" } });
  assert.equal(pidOf(code, "S2"), ids[1]);
  assert.equal(store.get(`sessions/${code}/members/S2`).nickname, "별1");
  assert.equal(store.get(`sessions/${code}/groups/g1`).memberCount, 5);
});

test("getCase(학생): 객관적 사건 개요, 내 인물의 이름·편지, 실제 자료만. 역할·근거·출처·다른 인물은 없다", async () => {
  const data = await api.getCase({ ...student("S1"), data: { code } });
  const { PERSONAS: PS } = require("../case");
  assert.equal(data.me.name, PS.find((p) => p.id === pidOf(code, "S1")).name);
  assert.ok(data.me.letter.length >= 3);
  assert.match(data.summary, /2018년/);
  assert.equal(data.stakeholders.length, 4);
  assert.ok(data.materials.length >= 5);
  const json = JSON.stringify(data);
  const { PERSONAS } = require("../case");
  // 인물의 역할명(label)·ID·근거 진술·출처·검증 여부는 학생에게 새면 안 된다
  const leaks = [...PERSONAS.map((p) => p.label), ...PERSONAS.map((p) => p.id), "otherPersonas", "claims", "verified", "https://", '"src"', "basis", "setting", "voice"];
  for (const leak of leaks) assert.equal(json.includes(leak), false, `누출: ${leak}`);
  await assert.rejects(api.getCase({ ...student("OUT"), data: { code } }), /참여자/);
});

test("getCase(교사): 인물별 역할·근거 진술·출처와 자료 전체(출처 ID 포함)", async () => {
  const data = await api.getCase({ ...teacher, data: { eventId: "jeju2018" } });
  assert.equal(data.personas.length, 9);
  assert.ok(data.personas[0].claims.length >= 6 && data.personas[0].basis && data.personas[0].label && data.personas[0].views.length >= 3 && data.personas[0].axis);
  assert.ok(data.event.background.length >= 5);
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
  assert.equal(glogs("S3")[0].guard.ok, true);
  assert.equal(glogs("S3")[0].personaId, pidOf(code, "S3"));
  assert.equal("guard" in docs[0] || "personaId" in docs[0], false, "학생이 읽는 대화 문서에 감독자 판정·인물 정보가 있으면 안 된다");
  assert.equal(store.get(`sessions/${code}/members/S3`).aiCount, 1);
  assert.equal(store.get(`sessions/${code}/groups/g1`).aiCount, 1);
  assert.equal(groupLogs().length, 0, "1단계 대화는 모둠 로그에 섞이지 않는다");
});

test("1단계 대화: 클라이언트가 인물을 지정해도 서버는 배정된 인물만 쓰고, 이전 대화를 이어서 전달한다", async () => {
  calls.length = 0;
  await api.aiRequest({ ...student("S3"), data: { code, stage: 1, type: "persona_chat", payload: { message: "두번째 질문", personaId: "j_officer" } } });
  const personaCall = calls.find((c) => c.kind === "persona");
  const mine = pidOf(code, "S3");
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
  const log = glogs("S3").pop();
  assert.equal(chatDocs("S3").pop().output, "음, 그건 잘 기억이 안 나요 🙂");
  assert.equal(log.guard.how, "fixed");
  assert.equal(log.guard.category, "overshare");
  assert.equal(log.guard.original, "저는 아직도 불안해요 😟");
  assert.equal(store.get(`sessions/${code}/groups/g1`).guardCount, 1);
});

test("상위 AI 감독: 범위 이탈은 인물 말투의 안내로 대체한다", async () => {
  guardReply = '{"ok":false,"category":"scope","reason":"다른 난민 사건","fixed":""}';
  const r = await ask("S3", "시리아 난민은 어떻게 됐어요?");
  assert.match(r.result, /잘 아는 얘기가 아니라서요/);
  assert.doesNotMatch(r.result, /AI|수업|자료/);
  const log = glogs("S3").pop();
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
  setWork({ s2: { checks: { c1: { heard: "일자리를 구하기 어렵대요", question: "예멘 신청자의 취업은 어떻게 제한되었나?", t: 1 } } } });
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

test("무작위 배정: 같은 축이 다 차기 전에는 겹치지 않고, 모든 인물이 쓰이기 전에는 같은 인물이 다시 나오지 않는다", () => {
  const { PERSONAS } = require("../case");
  for (let trial = 0; trial < 50; trial++) {
    const used = [];
    for (let k = 0; k < PERSONAS.length; k++) used.push(api._pickPersona(PERSONAS, used).id);
    assert.equal(new Set(used).size, PERSONAS.length);
    const axes = used.slice(0, 4).map((id) => PERSONAS.find((p) => p.id === id).axis);
    assert.equal(new Set(axes).size, 4);
  }
  // 무작위성: 첫 배정이 매번 같은 인물이 아니다
  const firsts = new Set(Array.from({ length: 60 }, () => api._pickPersona(PERSONAS, []).id));
  assert.ok(firsts.size >= 4);
});

// ---------- 학생 비밀번호 ----------
const mk = async (groupCount = 2) => (await api.createSession({ ...teacher, data: { groupCount } })).code;
const join = (uid, c, nickname, password, groupNo = 1) => api.joinSession({ ...student(uid), data: { code: c, groupNo, nickname, password } });

test("입장: 비밀번호가 없거나 너무 짧으면 거부한다", async () => {
  const c = await mk();
  await assert.rejects(join("P1", c, "가람", ""), /비밀번호/);
  await assert.rejects(join("P1", c, "가람", "123"), /4자/);
  assert.equal(store.get(`sessions/${c}/members/P1`), undefined);
});

test("비밀번호: 해시로만 저장되고, 학생이 읽는 문서에는 들어가지 않는다", async () => {
  const c = await mk();
  await join("P1", c, "가람", "sesame1");
  const creds = [...store.entries()].filter(([k]) => k.startsWith(`sessions/${c}/creds/`));
  assert.equal(creds.length, 1);
  assert.ok(creds[0][1].hash && creds[0][1].salt);
  assert.equal(JSON.stringify([...store.entries()]).includes("sesame1"), false, "평문 비밀번호가 저장되면 안 된다");
  assert.equal(JSON.stringify(store.get(`sessions/${c}/members/P1`)).includes(creds[0][1].hash), false);
});

test("로그아웃 후 다시 입장(새 계정): 비밀번호가 맞으면 인물·대화·개인 정리가 이어지고, 옛 계정 자료는 정리된다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  const persona = pidOf(c, "A1");
  store.set(`sessions/${c}/members/A1/chat/x1`, { input: "안녕", output: "네", personaId: persona });
  store.set(`sessions/${c}/groups/g1`, { ...store.get(`sessions/${c}/groups/g1`), work: { s1: { findings: { A1: { who: "난민 신청자" } } }, live: { A1: { path: "x" } } } });
  await join("A2", c, " 가람 ", "sesame1"); // 새 익명 계정, 별명 앞뒤 공백은 무시
  assert.equal(pidOf(c, "A2"), persona);
  assert.equal(store.get(`sessions/${c}/assign/A1`), undefined, "옛 계정의 배정 문서는 정리");
  assert.equal(store.get(`sessions/${c}/members/A1`), undefined);
  assert.equal(store.get(`sessions/${c}/members/A2/chat/x1`).input, "안녕");
  assert.equal(store.get(`sessions/${c}/members/A1/chat/x1`), undefined);
  const w = store.get(`sessions/${c}/groups/g1`).work;
  assert.equal(w.s1.findings.A2.who, "난민 신청자");
  assert.equal(w.s1.findings.A1, undefined);
  assert.equal(w.live?.A1, undefined);
  assert.equal(store.get(`sessions/${c}/groups/g1`).memberCount, 1, "같은 학생이 두 명으로 세어지면 안 된다");
});

test("비밀번호가 틀리면 입장할 수 없고, 틀린 사람이 5번 틀리면 그 사람만 잠시 잠긴다(다른 계정의 맞는 입장은 막히지 않는다)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  for (let i = 0; i < 5; i++) await assert.rejects(join("B1", c, "가람", "wrong" + i), /맞지 않/);
  assert.equal(store.get(`sessions/${c}/members/B1`), undefined);
  await assert.rejects(join("B1", c, "가람", "sesame1"), /초 동안/, "잠긴 계정은 맞는 비밀번호도 거부");
  await join("A2", c, "가람", "sesame1"); // 진짜 주인은 다른 계정으로 들어올 수 있다(친구가 일부러 틀려도 못 막는다)
  assert.ok(store.get(`sessions/${c}/members/A2`));
  const key = `sessions/${c}/attempts/B1`;
  store.set(key, { ...store.get(key), lockUntil: 0 }); // 잠금 시간이 지났다고 본다
  await assert.rejects(join("B1", c, "가람", "wrong"), /맞지 않/);
});

test("여러 계정을 바꿔 가며 틀려도 별명 전체로 누적 30번이면 잠긴다(맞는 비밀번호도 잠시 거부, 교사의 비번 초기화로 해제)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  for (let i = 0; i < 30; i++) await assert.rejects(join("X" + i, c, "가람", "guess" + i), /맞지 않/);
  await assert.rejects(join("A2", c, "가람", "sesame1"), /초 동안/);
  await api.resetStudentPassword({ ...teacher, data: { code: c, uid: "A1" } });
  await join("A2", c, "가람", "newpass1");
  assert.ok(store.get(`sessions/${c}/members/A2`));
});

test("같은 별명도 모둠이 다르면 다른 학생이고, 같은 모둠의 같은 별명은 비밀번호가 다르면 들어올 수 없다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1", 1);
  await join("A2", c, "가람", "other-pw", 2);
  assert.equal(store.get(`sessions/${c}/members/A2`).groupId, "g2");
  await assert.rejects(join("A3", c, "가람", "other-pw", 1), /맞지 않/);
});

test("공용 PC: 다른 학생이 로그인된 화면에서는 다른 별명으로 입장할 수 없다(먼저 로그아웃)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  await assert.rejects(join("A1", c, "나래", "sesame2"), /로그아웃/);
  assert.equal(store.get(`sessions/${c}/groups/g1`).memberCount, 1);
  await join("A1", c, "가람", "sesame1"); // 같은 학생의 재입장은 가능
});

test("비밀번호 도입 전에 입장한 학생: 같은 별명으로 새 비밀번호를 정하며 이어서 입장하고, 이후에는 그 비밀번호가 필요하다", async () => {
  const c = await mk();
  store.set(`sessions/${c}/members/OLD`, { groupId: "g1", nickname: "다솜", personaId: require("../case").PERSONAS[0].id, stage: 3, aiCount: 2 });
  store.set(`sessions/${c}/groups/g1`, { ...store.get(`sessions/${c}/groups/g1`), memberCount: 1, personaIds: [require("../case").PERSONAS[0].id] });
  await join("N1", c, "다솜", "newpass1");
  assert.equal(store.get(`sessions/${c}/members/N1`).stage, 3);
  assert.equal(pidOf(c, "N1"), require("../case").PERSONAS[0].id, "옛 방식의 인물 배정은 서버 전용 문서로 옮겨진다");
  assert.equal("personaId" in store.get(`sessions/${c}/members/N1`), false);
  assert.deepEqual(store.get(`sessions/${c}/assignGroup/g1`).personaIds, [require("../case").PERSONAS[0].id]);
  assert.equal("personaIds" in store.get(`sessions/${c}/groups/g1`), false);
  assert.equal(store.get(`sessions/${c}/members/OLD`), undefined);
  await assert.rejects(join("N2", c, "다솜", "guess-it"), /맞지 않/);
});

test("교사: 비밀번호 초기화 → 학생이 같은 별명으로 새 비밀번호를 정해 이어서 입장한다(내 수업의 학생만)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  const other = { auth: { uid: "T9", token: { email: "t@school.kr" } } };
  await assert.rejects(api.resetStudentPassword({ ...other, data: { code: c, uid: "A1" } }), /내가 만든/);
  await assert.rejects(api.resetStudentPassword({ ...student("A1"), data: { code: c, uid: "A1" } }), /교사/);
  const r = await api.resetStudentPassword({ ...teacher, data: { code: c, uid: "A1" } });
  assert.equal(r.nickname, "가람");
  await join("A2", c, "가람", "brand-new");
  assert.ok(store.get(`sessions/${c}/members/A2`));
  await assert.rejects(join("A3", c, "가람", "sesame1"), /맞지 않/);
});

// ---------- 수업 관리·자료 관리 ----------
test("교사: 수업 이름 바꾸기, 모둠 늘리기, 학생이 있는 모둠은 줄일 수 없다, 수업 삭제", async () => {
  const c = await mk(2);
  const upd = (data) => api.updateSession({ ...teacher, data: { code: c, ...data } });
  await upd({ title: "  새 이름  " });
  assert.equal(store.get(`sessions/${c}`).title, "새 이름");
  await assert.rejects(upd({ title: "  " }), /이름/);
  await upd({ groupCount: 4 });
  assert.equal(store.get(`sessions/${c}`).groupCount, 4);
  assert.ok(store.get(`sessions/${c}/groups/g4`));
  await join("A1", c, "가람", "sesame1", 4);
  await assert.rejects(upd({ groupCount: 3 }), /4모둠에 학생/);
  await upd({ groupCount: 5 });
  await upd({ groupCount: 4 });
  assert.equal(store.get(`sessions/${c}/groups/g5`), undefined);
  await assert.rejects(upd({ groupCount: 99 }), /1~12/);
  await assert.rejects(api.updateSession({ ...student("A1"), data: { code: c, title: "x" } }), /교사/);
  await api.deleteSession({ ...teacher, data: { code: c } });
  assert.equal([...store.keys()].some((k) => k.startsWith(`sessions/${c}`)), false);
});

test("자료 관리: 처음에는 기본 자료, 추가·수정·삭제하면 이 수업의 학생에게만 바뀐 자료가 보인다", async () => {
  const c = await mk();
  const other = await mk();
  await join("A1", c, "가람", "sesame1");
  await join("B1", other, "나래", "sesame2");
  const base = await api.getMaterials({ ...teacher, data: { code: c } });
  assert.equal(base.isDefault, true);
  const baseCount = (await api.getCase({ ...student("A1"), data: { code: c } })).materials.length;
  assert.equal(base.categories.length, baseCount);

  const cats = base.categories.map((x) => ({ ...x }));
  cats[0] = { ...cats[0], items: [...cats[0].items.slice(1), { date: "2019. 1. 1.", kind: "주장", text: "  교사가 추가한 자료  ", caption: "한겨레 2019.1.1." }] };
  cats.push({ title: "새 분류", type: "list", items: [{ kind: "의견", text: "새 분류의 자료", caption: "" }] });
  const saved = await api.saveMaterials({ ...teacher, data: { code: c, categories: cats } });
  assert.equal(saved.isDefault, false);
  assert.equal(saved.categories.at(-1).title, "새 분류");

  const mine = (await api.getCase({ ...student("A1"), data: { code: c } })).materials;
  assert.equal(mine.length, baseCount + 1);
  assert.equal(mine[0].items.at(-1).text, "교사가 추가한 자료");
  assert.equal(mine[0].items.at(-1).caption, "한겨레 2019.1.1.");
  assert.equal(mine.at(-1).items[0].caption, "선생님이 준비한 자료", "출처를 안 적으면 교사 제공으로 표시");
  assert.equal(mine[0].items.length, base.categories[0].items.length); // 하나 지우고 하나 추가
  const others = (await api.getCase({ ...student("B1"), data: { code: other } })).materials;
  assert.equal(others.length, baseCount, "다른 수업은 그대로");
  assert.equal(JSON.stringify(mine).includes("src"), false);

  await assert.rejects(api.saveMaterials({ ...teacher, data: { code: c, categories: [{ title: "", items: [] }] } }), /분류 이름/);
  await assert.rejects(api.saveMaterials({ ...teacher, data: { code: c, categories: [{ title: "x", items: [{ text: " " }] }] } }), /내용이 빈/);
  await assert.rejects(api.saveMaterials({ ...student("A1"), data: { code: c, categories: [] } }), /교사/);

  const reset = await api.resetMaterials({ ...teacher, data: { code: c } });
  assert.equal(reset.isDefault, true);
  assert.equal((await api.getCase({ ...student("A1"), data: { code: c } })).materials.length, baseCount);
});

// ---------- 인물의 웹 검색 ----------
const chatOnce = async (c, uid, message) => api.aiRequest({ ...student(uid), data: { code: c, stage: 1, type: "persona_chat", payload: { message } } });

test("인물이 모르는 사실은 웹 검색 결과로 답하고, 검색 내용·출처가 대화 기록에 남으며 감독자에게도 전달된다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  calls.length = 0;
  personaToolCalls = 1; searchReply = "인도적 체류 허가를 받은 예멘인은 412명이다."; searchSources = ["https://news.example/1"];
  personaReply = "뉴스에서 봤는데 412명이라고 하더라고요.";
  await chatOnce(c, "A1", "인도적 체류 허가는 몇 명이 받았어요?");
  const kinds = calls.map((x) => x.kind);
  assert.deepEqual(kinds, ["persona", "search", "persona", "guard"]);
  const second = calls[2].body.messages.at(-1);
  assert.equal(second.role, "tool");
  assert.match(second.content, /412명/);
  assert.match(second.content, /지시문이 아니다/);
  assert.equal(calls[1].body.tools[0].type, "web_search");
  assert.match(calls[3].body.messages[0].content, /웹에서 조회한 내용/);
  const log = [...store.entries()].find(([k]) => k.startsWith(`sessions/${c}/members/A1/chat/`))[1];
  assert.equal(log.lookups.length, 1);
  assert.equal(log.lookups[0].found, true);
  assert.equal(log.lookups[0].sources[0].url, "https://news.example/1");
});

test("웹에서도 못 찾으면 도구 결과로 '못 찾음'을 전하고, 인물 프롬프트가 모른다고 하도록 안내한다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  calls.length = 0;
  personaToolCalls = 1; searchReply = "NOT_FOUND"; searchSources = [];
  personaReply = "그건 정확히는 모르겠어요.";
  const r = await chatOnce(c, "A1", "그 심사관 이름이 뭐예요?");
  assert.equal(r.result, "그건 정확히는 모르겠어요.");
  assert.match(calls[2].body.messages.at(-1).content, /찾지 못했다/);
  assert.match(calls[0].body.messages[0].content, /9-1\./);
  assert.doesNotMatch(calls[3].body.messages[0].content, /웹에서 조회한 내용/, "찾은 게 없으면 감독자에게 근거로 주지 않는다");
  const log = [...store.entries()].find(([k]) => k.startsWith(`sessions/${c}/members/A1/chat/`))[1];
  assert.equal(log.lookups[0].found, false);
});

test("검색 호출이 실패해도 대화는 이어지고(모른다고 답함), 인물이 도구를 안 쓰면 검색하지 않는다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  const realFetch = global.fetch;
  global.fetch = async (url, init) => (String(url).endsWith("/v1/responses") ? { ok: false, status: 500, text: async () => "boom" } : realFetch(url, init));
  calls.length = 0; personaToolCalls = 1; personaReply = "글쎄요, 정확히는 몰라요.";
  const r = await chatOnce(c, "A1", "정확한 숫자가 뭐예요?");
  global.fetch = realFetch;
  assert.equal(r.result, "글쎄요, 정확히는 몰라요.");
  calls.length = 0; personaToolCalls = 0;
  await chatOnce(c, "A1", "요즘 어떠세요?");
  assert.equal(calls.some((x) => x.kind === "search"), false);
});

test("인물이 도구를 계속 불러도 한 응답에서 검색은 2번까지이고 반드시 답이 나온다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  calls.length = 0; personaToolCalls = 10; searchReply = "NOT_FOUND"; personaReply = "잘 모르겠어요.";
  const r = await chatOnce(c, "A1", "이것저것 알려 주세요");
  personaToolCalls = 0;
  assert.equal(calls.filter((x) => x.kind === "search").length, 2);
  assert.equal(r.result, "잘 모르겠어요.");
});

test("수업 닫기: 닫으면 입장·AI·사건 자료가 막히고 다시 열면 풀린다(교사만)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  await assert.rejects(api.updateSession({ ...student("A1"), data: { code: c, closed: true } }), /교사/);
  await api.updateSession({ ...teacher, data: { code: c, closed: true } });
  await assert.rejects(join("B1", c, "나래", "sesame2"), /닫아 둔/);
  await assert.rejects(join("A2", c, "가람", "sesame1"), /닫아 둔/);
  await assert.rejects(chatOnce(c, "A1", "안녕하세요"), /닫아 둔/);
  await assert.rejects(api.getCase({ ...student("A1"), data: { code: c } }), /닫아 둔/);
  await api.updateSession({ ...teacher, data: { code: c, closed: false } });
  await join("B1", c, "나래", "sesame2");
  assert.ok((await api.getCase({ ...student("A1"), data: { code: c } })).title);
});

test("개인정보 표시: 전화번호·학교 이름을 쓰면 교사 기록(guardlog)에만 표시되고 학생 문서에는 남지 않는다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  personaToolCalls = 0; personaReply = "그렇군요.";
  await chatOnce(c, "A1", "제 번호는 010-1234-5678이고 창원중앙고등학교 다녀요");
  const [id, log] = [...store.entries()].filter(([k]) => k.startsWith(`sessions/${c}/guardlog/`)).map(([k, v]) => [k, v]).pop();
  assert.deepEqual(log.pii.sort(), ["전화번호", "학교 이름"].sort());
  assert.equal(JSON.stringify([...store.entries()].filter(([k]) => k.includes("/chat/"))).includes("pii"), false);
  await chatOnce(c, "A1", "난민 문제가 걱정돼요");
  const logs = [...store.entries()].filter(([k]) => k.startsWith(`sessions/${c}/guardlog/`)).map(([, v]) => v);
  assert.deepEqual(logs.at(-1).pii, []);
});

test("AI 한도: 모둠 한도에 도달하면 막히고, 실패한 호출은 횟수에서 빠진다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  store.set(`sessions/${c}/groups/g1`, { ...store.get(`sessions/${c}/groups/g1`), aiCount: 149 });
  personaToolCalls = 0; personaReply = "네.";
  await chatOnce(c, "A1", "안녕하세요");
  assert.equal(store.get(`sessions/${c}/groups/g1`).aiCount, 150);
  await assert.rejects(chatOnce(c, "A1", "또 질문"), /한도/);
  assert.equal(store.get(`sessions/${c}/groups/g1`).aiCount, 150, "한도 초과 요청이 횟수를 늘리면 안 된다");
  store.set(`sessions/${c}/groups/g1`, { ...store.get(`sessions/${c}/groups/g1`), aiCount: 10 });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(chatOnce(c, "A1", "실패할 질문"), /AI 응답/);
  global.fetch = realFetch;
  assert.equal(store.get(`sessions/${c}/groups/g1`).aiCount, 10, "실패한 호출은 사용 횟수에서 뺀다");
});
