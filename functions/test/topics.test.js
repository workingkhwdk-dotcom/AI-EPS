process.env.TOPIC_BUILDER_ENABLED = "true"; // 새 주제 만들기 스위치(기본은 꺼짐)를 켜고 시험한다
// 교사 주제 만들기(topics) 통합 테스트: 가짜 Firebase + 가짜 OpenAI 로 아이디어 → 조사 → 사건 틀 → 인물 → 자료 → 점검 →
// 원문 확인 → 수업 만들기 → 학생 입장·인물 대화까지 이어서 확인한다.
const test = require("node:test");
const assert = require("node:assert");
const { store, strings } = require("./fake-firebase");
// 선생님 컴퓨터의 .env 처럼 지원이 끝나는 옛 모델 이름이 남아 있는 상황(서버가 새 모델로 바꿔 써야 한다)
Object.assign(strings, { PERSONA_MODEL: "gpt-5", GUARD_MODEL: "gpt-5-2025-08-07", SCENARIO_MODEL: "gpt-5", FEEDBACK_MODELS: "gpt-5-mini,gpt-5.6-sol" });
const { ANGLES } = require("../topicBuild");

// ---------- 가짜 OpenAI ----------
const calls = [];
let frameBadFirst = 1; // 처음 한 번은 인물 8명짜리 구성안을 돌려준다(다시 짜게 하는지 확인)
const AX = ["주민", "주민", "주민", "생업", "생업", "시민사회", "시민사회", "제도", "제도"];
const SIDES = ["A", "B", "가운데", "A", "B", "A", "B", "B", "가운데"];
const NAMES = ["김민수", "박영희", "이순자", "최도윤", "정하늘", "한지민", "오세훈", "윤가람", "강보람"];
const MARKS = [["부두에서 손을 흔들던", "손을 흔들던 아저씨"], ["새벽 첫 배에서", "첫 배 선장님"], ["시청 앞 천막에서", "천막을 지키던"], ["조선소 정문 앞에서", "정문 앞 국밥집"], ["마을 회관 설명회", "설명회에서 손을 든"]];

// 인용 링크가 붙은 검색 답을 만든다: 줄 끝의 ([기사](url)) 위치에 url_citation 을 단다
function cited(lines) {
  let text = "";
  const annotations = [];
  for (const l of lines) {
    const link = l.url ? ` ([기사](${l.url}))` : "";
    if (l.url) annotations.push({ type: "url_citation", url: l.url, title: `거제 기사 ${l.url.split("/").slice(-2).join("-")}`, start_index: text.length + l.text.length + 1, end_index: text.length + l.text.length + link.length });
    text += l.text + link + "\n";
  }
  return { text, annotations };
}
function searchReply(instr) {
  if (instr.includes("후보 3~4개")) {
    return cited([
      { text: "### 거제 조선소 하청 노동과 지역 경제 (2022~2025)" },
      { text: "장소: 경남 거제시" }, { text: "기간: 2022~2025" },
      { text: "요약: 조선업 경기가 오르내리며 하청 노동자의 임금과 지역 상권이 함께 흔들렸다. 2022년 하청 노동자 파업이 있었다.", url: "https://news.example.com/idea/1" },
      { text: "쟁점: 원청과 하청, 주민과 상인이 일자리와 임금, 지역 경제를 두고 부딪힌다." },
      { text: "이해관계자: 하청 노동자 / 조선소 주변 상인 / 노동·시민단체 / 거제시와 고용노동부" },
      { text: "꼭 들어야 할 사람: 조선소 하청 노동자" }, { text: "대화 시점: 2025년 3월 초, 새 고용 대책 발표 직후" },
      { text: "수업에 좋은 점: 입장이 고르게 나뉜다.", url: "https://news.example.com/idea/2" }, { text: "조심할 점: 실존 노조 위원장 이름이 기사에 많다." },
      { text: "### 거제 섬 지역 의료 공백 (2023~2025)" },
      { text: "장소: 경남 거제시 섬 마을" }, { text: "기간: 2023~2025" },
      { text: "요약: 섬 마을의 응급 의료가 부족하다는 문제가 이어졌다.", url: "https://news.example.com/idea/3" },
    ]);
  }
  const angle = ANGLES.find((a) => instr.includes(`이번에 찾을 것: ${a.label}`));
  const k = angle.key;
  const kinds = { flow: "사실", people: "증언", claims: "주장", gov: "사실", numbers: "사실", experts: "의견", elsewhere: "사실", after: "사실" };
  const lines = [];
  for (let i = 1; i <= 6; i++) {
    const n = k === "numbers" ? ` 2024년 기준 ${i * 1000}명이었다` : "";
    lines.push({ text: `- [${kinds[k]}] ${k} 각도의 ${i}번째 내용으로 거제 조선소 하청 노동과 지역 경제에 관한 문장이다${n}.`, url: `https://news.example.com/${k}/${i}?utm_source=x` });
  }
  lines.push({ text: `- [사실] 인용이 없는 ${k} 문장은 버려져야 한다.` });
  lines.push({ text: "@이름: 홍길동, 김철수(시장)" });
  return cited(lines);
}

const factIds = (s, head) => {
  const part = head ? s.split(head)[1]?.split(/\n\[/)[0] || "" : s;
  return [...part.matchAll(/^(F\d+) /gm)].map((m) => m[1]);
};
function frameReply(user) {
  const ids = factIds(user, "[사실 은행]");
  const n = frameBadFirst-- > 0 ? 8 : 9;
  return {
    event: {
      title: "거제 조선소 하청 노동과 지역 경제 (2022~2025)",
      summary: "거제에서는 조선업 경기가 오르내리며 하청 노동자의 임금과 지역 상권이 함께 흔들렸다. 2022년에는 하청 노동자들의 파업이 있었고, 이후 정부와 시가 대책을 내놓았다. 원청과 하청, 상인과 주민의 생각은 서로 다르다. 지금도 인력 부족과 임금 격차를 두고 논쟁이 이어진다. (이 설명과 인물은 언론 보도에 근거한 수업용 구성이다.)",
      teacherNote: "노동자 대 회사의 대결로만 보지 않도록 상인과 주민, 행정의 처지를 함께 보게 한다. 수치는 보도마다 다르니 원문을 확인한다.",
      axes: ["주민", "생업", "시민사회", "제도"], requiredAxis: "주민", personalAxes: ["주민", "생업"],
      stakeholders: ["조선소 곁 주민", "하청 노동자와 상인", "노동·시민단체", "거제시와 고용노동부"],
      background: ids.slice(0, 7),
      now: "지금은 2025년 3월 초다. 정부가 조선업 인력 대책을 발표한 직후다.",
      backgroundIntro: "거제에 사는 사람이면 대부분 아는 사실이다. 너도 안다.",
      scope: { event: "2022~2025년 거제 조선소 하청 노동과 지역 경제 갈등", time: "2022년 파업부터 2025년 3월까지", place: "경남 거제시와 이 일과 직접 관련된 기관",
        allowedTopics: ["하청 노동자의 임금과 일", "조선소 주변 상권", "정부와 시의 대책"], outOfScope: ["다른 지역의 노동 갈등", "실존 인물 개인에 대한 평가, 2025년 3월 이후의 전개"] },
      search: { scope: "2022~2025년 거제 조선소 하청 노동이다. 2025년 3월 이후의 내용은 쓰지 않는다.", example: "2022년 거제 조선소 하청 노동자 파업 기간" },
      ui: { letterSign: "2025년 3월, 거제에서", causeExample: "하청 구조 때문에 임금이 오르기 어렵다", badQuestion: "회사가 나쁜가?", goodQuestion: "2022년 파업은 며칠 동안 이어졌나?",
        checkQuestion: "하청 노동자의 임금은 원청보다 얼마나 낮나?", heardExample: "○○: 월급이 10년째 그대로다", broadProblem: "노동 문제", decidedProblem: "하청을 없애야 한다",
        pickLead: "거제에는 입장이 서로 다른 여러 사람이 있어요.", requiredWho: "조선소 곁에 사는 주민", requiredTag: "주민", casesKinds: "일자리를 지키는 서로 다른 방법",
        compareWith: "거제", afterSince: "2025년 3월", afterExample: "우리는 임금이 오를 거라 예상했지만, 실제로는 인력이 더 빠져나갔다",
        priorQuestion: "부모님이나 이웃이 일하는 곳이 어려워지면 동네에는 어떤 일이 생길까요?", priorHint: "예) 가게가 문을 닫는다 / 잘 모르겠다 / 사람들이 떠난다",
        sceneHints: ["내가 열심히 했는데 대가가 적었던 때", "누군가의 요구 때문에 내가 손해 볼까 걱정했던 때", "내가 당연하게 쓰는 물건을 누가 만드는지 몰랐던 것"] },
      realNames: ["홍길동"],
    },
    sides: { A: "하청 노동자 처우 개선 쪽", B: "회사 경쟁력·고용 유지 쪽" },
    personas: NAMES.slice(0, n).map((name, i) => ({ axis: AX[i], name, label: `${AX[i]} 인물 ${i + 1} (입장 ${SIDES[i]})`, role: `거제의 ${AX[i]} 처지 인물`, side: SIDES[i],
      stance: `입장 ${SIDES[i]} 쪽에서 구체적인 안을 가진다`, who: `${40 + i}대 ${i % 2 ? "여성" : "남성"} ${AX[i]}`, brief: `거제의 ${AX[i]} ${i + 1}`,
      facts: ids.slice(i * 3, i * 3 + 7), belief: i < 5 ? "조선소가 곧 다시 크게 살아날 것이라고 믿는다" : "" })),
    links: MARKS.map(([a, b], i) => ({ a: i + 1, b: i + 5, scene: `장면 ${i + 1}`, a_mark: a, b_mark: b })),
    balance: "A 3, B 4, 가운데 2",
  };
}
function personaReply(user) {
  const name = /이름: (\S+) \//.exec(user)[1];
  const axis = /처지\(축\): ([^(]+)\(/.exec(user)[1];
  const marks = [...user.matchAll(/'([^']+)' 라는 말을 그대로/g)].map((m) => m[1]);
  const ids = factIds(user, "[이 인물의 사실]").slice(0, 7);
  const personal = ["주민", "생업"].includes(axis);
  return {
    label: `${axis} 인물 (다듬음)`, role: `거제에서 ${axis} 처지로 사는 사람`, stance: "자기 처지에서 분명한 안을 가진다", brief: `거제의 ${axis}`,
    setting: personal ? `쉰두 살 남성. 거제 옥포에서 30년째 산다. 아내와 딸 둘이 있다. 조선소 곁에서 일해 왔다.` : "거제에서 일하는 단체 활동가다. 지역 노동 문제를 10년 넘게 맡아 왔다.",
    voice: "차분한 해요체. 사투리가 조금 섞이고 이모지는 거의 쓰지 않는다.", habits: "말끝에 '그렇지예'를 가끔 붙인다.",
    inner: "가족을 지키고 싶은 마음과 동네가 무너질까 하는 걱정이 함께 있다. 쉽게 말하지 못한다.",
    basis: "거제 주민·노동자 기사들을 융합했다. 가족 설정은 창작이며 특정 개인을 나타내지 않는다.",
    letter: [`안녕하세요. 저는 ${name}이에요. 거제에서 오래 살았어요. 바다 냄새가 나는 이 동네가 저는 참 좋아요. 학생들이 제 이야기를 들어 준다니 고마워요.`, "아침마다 조선소로 가는 버스가 길게 줄을 서요. 그 줄을 보면 이 동네가 아직 살아 있다는 생각이 들어요.",
      "몇 해 전에는 일이 줄어서 동네 가게들이 하나둘 문을 닫았어요. 그때 이웃들 얼굴이 많이 어두웠어요.", "요즘은 다시 배를 많이 만든다고 하는데, 일하는 사람 사정은 그렇게 나아진 것 같지 않아요.",
      "저는 우리 아이들이 이 동네에서 계속 살 수 있으면 좋겠어요. 그게 제일 큰 바람이에요.", "물론 회사 사정도 있고, 시청이 할 수 있는 일에도 한계가 있다는 건 알아요.",
      "그래도 서로 이야기를 나누면 조금씩 나아질 수 있다고 믿어요. 지난번 동네 모임에서도 처음엔 다들 목소리가 높았지만 끝에는 같이 국수를 먹었어요.", "궁금한 게 있으면 무엇이든 물어봐 주세요. 솔직하게 말할게요."],
    views: ["일한 만큼 받는 게 맞다고 생각해요.", "회사가 무너지면 동네도 무너진다는 걱정도 이해해요.", "시청이 중간에서 더 많이 들어 줬으면 해요.", "외부에서 온 사람들과도 함께 살 길을 찾아야 해요.", "급하게 정하기보다 오래 갈 방법을 찾고 싶어요."],
    story: [`쉰두 살. 거제 옥포에서 태어나 자랐다. ${marks[0] || ""}`, "스무 살에 처음 조선소 일을 시작했다.", `서른에 결혼해 딸 둘을 두었다. ${marks[1] || ""}`, "일이 줄던 해에는 한동안 일을 쉬었다.", "다시 일을 시작했지만 마음이 편하지는 않았다.", "지금은 동네 일에도 조금씩 나선다."],
    episodes: ["비 오는 날 퇴근 버스에서 동료와 말없이 창밖을 본 일", "딸 졸업식에 일 때문에 늦게 도착한 날", "동네 국밥집 사장님이 외상을 받아 준 날", "설명회에서 처음으로 손을 들고 말한 날", "바닷가에서 큰 배가 바다로 나가는 걸 본 날"],
    beliefs: [{ text: "조선소 일감이 앞으로 십 년은 넘칠 거라고 믿고 있다", note: "실제 전망은 기관마다 다르다. 자료로 확인하게 한다." }],
    limits: [], claims: ids,
  };
}
function materialsReply(user) {
  const ids = factIds(user);
  let k = 0;
  const take = (n) => ids.slice(k, (k += n));
  const item = (f, kind = "사실") => ({ kind, text: `학생이 읽기 쉬운 문장으로 쓴 ${f} 내용이다.`, facts: [f] });
  return { categories: [
    { id: "timeline", title: "사건 흐름", type: "timeline", items: take(4).map((f, i) => ({ ...item(f), date: `2024. ${i + 1}.` })) },
    { id: "numbers", title: "숫자로 보는 거제", type: "list", stats: [{ label: "하청 노동자", value: "1만 명", fact: ids[30] }], items: take(2).map((f) => item(f)) },
    { id: "workers", title: "하청 노동자의 목소리", items: take(3).map((f) => item(f, "증언")) },
    { id: "shops", title: "상인과 주민", items: take(2).map((f) => item(f)) },
    { id: "gov", title: "시와 정부의 대책", items: [...take(2).map((f) => item(f)), item(ids[0])] }, // 앞에서 쓴 사실을 되풀이한 항목은 빠진다
  ] };
}
function casesReply(user) {
  const els = factIds(user, "[다른 곳의 사례에 쓸 사실]"), aft = factIds(user, "[이후 전개에 쓸 사실]");
  const card = (i) => ({ id: `case${i}`, country: ["울산", "일본 나가사키", "독일 함부르크"][i], title: `사례 ${i + 1}`, what: "그 지역은 조선업 노동자의 재교육과 임금 보전을 함께 하는 제도를 만들었다.",
    result: "실직자가 줄었다는 평가와 비용이 너무 크다는 비판이 함께 나왔다. 지금도 논쟁이 있다.", think: "거제에서도 같은 방법을 쓸 수 있을까? 비용은 누가 낼까?", facts: [els[i]] });
  return { cases: [card(0), card(1), card(2)], aftermath: aft.slice(0, 4).map((f) => ({ kind: "사실", text: `대화 시점 뒤에 일어난 ${f} 일이다.`, facts: [f] })) };
}
function personaReviewReply(user) {
  return user.includes(`[인물] ${NAMES[0]} `)
    ? { issues: [{ field: "letter", index: 2, problem: "fabrication", reason: "근거에 없는 수치", fixed: "몇 해 전에는 일이 줄어서 가게들이 문을 닫았어요. 이웃들 얼굴이 어두웠어요." }] }
    : { issues: [] };
}

global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  // 인물의 사실 찾아보기(함수 도구)는 Responses API 로 온다: 도구를 쓰지 않고 바로 답한다
  if (String(url).endsWith("/v1/responses") && body.tools?.[0]?.type === "function") {
    calls.push({ kind: "chat", body: { ...body, messages: body.input.filter((x) => x.role) } });
    return { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "음… 저는 일한 만큼 받으면 좋겠어요." }] }] }) };
  }
  if (String(url).endsWith("/v1/responses")) {
    calls.push({ kind: "search", body });
    const r = searchReply(body.instructions);
    return { ok: true, json: async () => ({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: r.text, annotations: r.annotations }] }] }) };
  }
  const sys = body.messages[0].content, user = body.messages[1]?.content || "";
  const kind = sys.includes("기사 목록을 정리하는 도우미") ? "meta" : sys.includes("사건의 틀과 인물 9명의 구성안") ? "frame" : sys.includes("인물 한 명을 완성한다") ? "persona"
    : sys.includes("실제 사건 자료'를 만드는") ? "materials" : sys.includes("'다른 곳의 사례' 카드") ? "cases" : sys.includes("내보내기 전에 검토하는 편집자") ? "preview"
    : sys.includes("근거 문장과 맞는지") ? "mreview" : sys.includes("입장 분포가 한쪽으로") ? "balance" : sys.includes("상위 감독자") ? "guard" : sys.includes("메신저 대화") ? "chat" : "other";
  calls.push({ kind, body });
  const content = kind === "meta" ? JSON.stringify({ sources: [...user.matchAll(/^(\d+)\. 제목/gm)].map((m) => ({ n: +m[1], outlet: "테스트일보", date: "2025-02-1" + (m[1] % 9), title: `기사 ${m[1]}` })) })
    : kind === "frame" ? JSON.stringify(frameReply(user)) : kind === "persona" ? JSON.stringify(personaReply(user)) : kind === "materials" ? JSON.stringify(materialsReply(user))
    : kind === "cases" ? JSON.stringify(casesReply(user)) : kind === "preview" ? JSON.stringify(personaReviewReply(user)) : kind === "mreview" ? '{"issues":[]}'
    : kind === "balance" ? '{"ok":true,"notes":["입장이 고르게 나뉘었다."]}' : kind === "guard" ? '{"ok":true,"category":"ok","reason":"","fixed":""}'
    : kind === "chat" ? "음… 저는 일한 만큼 받으면 좋겠어요." : "{}";
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
};

const api = require("../index.js");
const teacher = { auth: { uid: "T1", token: { email: "t@school.kr", email_verified: true } } };
const other = { auth: { uid: "T2", token: { email: "b@school.kr", firebase: { sign_in_provider: "password" } } } };
store.set("teacherAccounts/T2", { email: "b@school.kr" });
const topics = (who, data) => api.topics({ ...who, data });
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
let tid, code;

test("사건 후보 찾기: 웹 검색 답에서 후보와 인용 링크를 꺼내고, 하루 횟수를 센다", async () => {
  const r = await topics(teacher, { action: "ideas", idea: "거제도 지역 문제", grade: "고2 통합사회" });
  assert.equal(r.candidates.length, 2);
  const c = r.candidates[0];
  assert.equal(c.title, "거제 조선소 하청 노동과 지역 경제 (2022~2025)");
  assert.equal(c.place, "경남 거제시");
  assert.deepEqual(c.stakeholders, ["하청 노동자", "조선소 주변 상인", "노동·시민단체", "거제시와 고용노동부"]);
  assert.match(c.summary, /파업이 있었다/);
  assert.doesNotMatch(c.summary, /https?:|\[기사\]/, "인용 표시는 떼어 낸다");
  assert.deepEqual(c.links.map((l) => l.url), ["https://news.example.com/idea/1", "https://news.example.com/idea/2"], "후보 범위 안의 인용 링크만");
  assert.equal(r.usage.ideas, 1);
  await rejects(topics(teacher, { action: "ideas", idea: "" }), /지역이나 주제/);
  await rejects(api.topics({ auth: { uid: "S1", token: { firebase: { sign_in_provider: "anonymous" } } }, data: { action: "list" } }), /교사 계정이 아닙니다/);
});

test("주제 만들기 시작 → 조사: 인용 링크가 붙은 문장만 사실 은행에 들어가고, 출처는 주소로 합쳐진다", async () => {
  const { candidates } = await topics(teacher, { action: "ideas", idea: "거제" });
  const s = await topics(teacher, { action: "start", candidate: candidates[0], idea: "거제", now: "2025년 3월 초" });
  tid = s.topicId;
  assert.match(tid, /^t[0-9a-f]{10}$/);
  assert.equal(s.usage.topics, 1);
  assert.equal(store.get(`teacherTopics/${tid}`).ownerUid, "T1");
  await rejects(topics(teacher, { action: "frame", topicId: tid }), /이 단계를 할 수 없습니다/);
  const r = await topics(teacher, { action: "research", topicId: tid });
  assert.equal(r.facts, ANGLES.length * 6, "각도마다 인용이 붙은 6줄만(인용 없는 줄은 버림)");
  assert.equal(r.sources, ANGLES.length * 6, "utm 꼬리표를 뗀 주소로 출처를 합친다");
  const research = store.get(`teacherTopics/${tid}/parts/research`);
  assert.ok(research.facts.every((f) => /^F\d+$/.test(f.id) && f.src.every((x) => research.SOURCES[x])));
  assert.ok(Object.values(research.SOURCES).every((x) => !/utm_/.test(x.url) && x.outlet === "테스트일보" && x.verified === false));
  assert.deepEqual(research.names, ["홍길동", "김철수"]);
  assert.ok(research.facts.some((f) => f.kind === "증언") && research.facts.some((f) => f.kind === "주장"));
  assert.ok(!research.facts.some((f) => /인용이 없는/.test(f.text)));
});

test("사건 틀: 구성안에 문제가 있으면 한 번 다시 짜게 하고, 공통 배경은 사실 은행 문장을 그대로 쓴다", async () => {
  const r = await topics(teacher, { action: "frame", topicId: tid });
  const frames = calls.filter((c) => c.kind === "frame");
  assert.equal(frames.length, 2, "인물 8명짜리 첫 답은 다시 짜게 했다");
  assert.match(frames[1].body.messages[1].content, /personas 는 9명이어야 한다/);
  assert.equal(r.plan.personas.length, 9);
  assert.deepEqual(r.plan.personas.map((p) => p.id), ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
  assert.equal(r.event.id, tid);
  const research = store.get(`teacherTopics/${tid}/parts/research`);
  assert.ok(r.event.background.every(([text, src]) => research.facts.some((f) => f.text === text && f.src[0] === src)));
  assert.ok(r.event.realNames.includes("홍길동") && r.event.realNames.includes("김철수"));
  // 본보기(기본 주제)와 원칙이 프롬프트에 들어간다
  assert.match(frames[1].body.messages[0].content, /주남저수지/);
  assert.match(frames[1].body.messages[0].content, /실존 인물은 인물로 만들지 않고/);
});

test("구성안 고치기: 이름·입장을 고칠 수 있고, 겹치는 이름은 막는다", async () => {
  const t = await topics(teacher, { action: "get", topicId: tid });
  const plan = JSON.parse(JSON.stringify(t.plan));
  plan.personas[8].name = "강나래";
  plan.personas[8].stance = "가운데에서 서로의 안을 잇는다";
  const r = await topics(teacher, { action: "plan", topicId: tid, plan });
  assert.equal(r.plan.personas[8].name, "강나래");
  plan.personas[1].name = plan.personas[0].name;
  await rejects(topics(teacher, { action: "plan", topicId: tid, plan }), /이름이 겹칩니다/);
  await rejects(topics(other, { action: "get", topicId: tid }), /내가 만든 주제가 아닙니다/);
});

test("인물: 세 명씩 만들고, 근거 진술은 사실 은행 문장 그대로이며 스치는 장면 표시 말이 들어간다", async () => {
  let r;
  for (let i = 0; i < 3; i++) r = await topics(teacher, { action: "personas", topicId: tid });
  assert.deepEqual([r.done, r.total, r.step], [9, 9, "personas"]);
  await rejects(topics(teacher, { action: "plan", topicId: tid, plan: {} }), /인물을 만들기 전에만/);
  const t = await topics(teacher, { action: "get", topicId: tid });
  const fm = new Map(t.research.facts.map((f) => [f.text, f]));
  for (const p of t.file.PERSONAS) {
    assert.ok(p.claims.length >= 6, p.id);
    assert.ok(p.claims.every(([text, src, kind]) => fm.get(text)?.src[0] === src && fm.get(text).kind === kind), `${p.id}: 근거 진술은 사실 은행 그대로`);
    assert.ok(t.file.BRIEFS[p.id]);
  }
  assert.equal(t.file.PERSONAS[8].name, "강나래", "교사가 고친 구성안 이름을 쓴다");
  const p1 = t.file.PERSONAS[0], p5 = t.file.PERSONAS[4];
  assert.ok(p1.story.join(" ").includes(MARKS[0][0]) && p5.story.join(" ").includes(MARKS[0][1]));
  const prompt = calls.find((c) => c.kind === "persona").body.messages[0].content;
  assert.match(prompt, /박상규/, "기본 주제 인물 하나를 본보기로 준다");
  assert.match(prompt, /자료, 보도, 인터뷰, AI, 챗봇, 수업용/);
});

test("자료·사례·이후 전개 → 점검: AI 가 고친 문장을 적용·기록하고, 쓰이지 않는 출처를 빼며, 구조 검사 오류가 없다", async () => {
  const e = await topics(teacher, { action: "extras", topicId: tid });
  assert.deepEqual([e.materials, e.cases, e.aftermath], [5, 3, 4]);
  const r = await topics(teacher, { action: "review", topicId: tid });
  assert.equal(r.errors, 0);
  assert.equal(r.fixes, 1);
  const t = await topics(teacher, { action: "get", topicId: tid });
  assert.equal(t.status, "review");
  assert.equal(t.file.PERSONAS[0].letter[2], "몇 해 전에는 일이 줄어서 가게들이 문을 닫았어요. 이웃들 얼굴이 어두웠어요.");
  assert.equal(t.review.fixes[0].problem, "fabrication");
  assert.deepEqual(t.check.errors, []);
  assert.equal(t.file.MATERIALS.find((c) => c.id === "gov").items.length, 2, "앞 분류에서 쓴 사실을 되풀이한 항목은 뺐다");
  const used = new Set([...t.file.PERSONAS.flatMap((p) => p.claims.map((c) => c[1])), ...t.file.EVENT.background.map((c) => c[1]),
    ...t.file.MATERIALS.flatMap((m) => [...(m.statsSrc || []), ...m.items.flatMap((i) => i.src)]), ...t.file.POLICY_CASES.flatMap((c) => c.src), ...t.file.AFTERMATH.flatMap((a) => a.src)]);
  assert.deepEqual(Object.keys(t.file.SOURCES).sort(), [...used].sort(), "쓰이는 출처만 남는다");
  assert.ok(Object.values(t.file.SOURCES).every((x) => /^원문에서 확인할 것: ①/.test(x.check)));
  assert.equal(t.usable, 0, "원문 확인 전에는 학생에게 쓸 인물이 없다(.env 에 예전 리허설 설정이 true 로 남아 있어도)");
  assert.deepEqual(t.review.balance, { ok: true, notes: ["입장이 고르게 나뉘었다."] });
});

test("원문 확인 전에는 수업을 만들 수 없고, 출처를 확인하면 그 출처를 쓰는 인물이 학생에게 쓰인다", async () => {
  await rejects(api.createSession({ ...teacher, data: { topicId: tid, groupCount: 2 } }), /원문 확인을 마친 인물이 없습니다/);
  const t = await topics(teacher, { action: "get", topicId: tid });
  const ids = Object.keys(t.file.SOURCES);
  const r = await topics(teacher, { action: "verifySource", topicId: tid, sourceIds: ids });
  assert.equal(r.usable, 9);
  assert.equal(r.requiredOk, true);
  await rejects(topics(other, { action: "verifySource", topicId: tid, sourceIds: ids }), /내가 만든 주제가 아닙니다/);
  await rejects(api.createSession({ ...other, data: { topicId: tid } }), /내가 만든 주제가 아닙니다/);
  const list = await topics(teacher, { action: "list" });
  assert.equal(list.topics.length, 1);
  assert.equal(list.topics[0].usable, 9);
  assert.equal(list.topics[0].verified, ids.length);
});

test("교사 주제로 수업: 주제가 수업에 복사되고, 학생은 그 주제의 편지·자료로 수업하며 인물 대화도 그 사건으로 한다", async () => {
  const { code: c } = await api.createSession({ ...teacher, data: { topicId: tid, groupCount: 2 } });
  code = c;
  const sess = store.get(`sessions/${code}`);
  assert.equal(sess.topicId, tid);
  assert.equal(sess.eventId, tid);
  assert.equal(sess.title, "거제 조선소 하청 노동과 지역 경제 (2022~2025)");
  assert.equal(store.get(`sessions/${code}/private/topic`).topicId, tid);
  await api.updateSession({ ...teacher, data: { code, started: true } });
  const j = await api.joinSession({ auth: { uid: "S1", token: {} }, data: { code, groupNo: 1, nickname: "다솜", password: "1234" } });
  assert.equal(j.case.title, sess.title);
  assert.equal(j.case.letters.length, 9);
  assert.equal(j.case.letters[0].brief, "거제의 주민");
  assert.deepEqual(j.case.letters.map((l) => l.required), [true, true, true, false, false, false, false, false, false]);
  assert.deepEqual(j.case.letters.map((l) => l.personal), [true, true, true, true, true, false, false, false, false]);
  assert.equal(j.case.ui.compareWith, "거제");
  assert.ok(j.case.materials.length >= 4 && j.case.materials[0].items[0].caption.startsWith("테스트일보"));
  assert.equal(j.case.cases.length, 3);
  assert.equal(j.case.aftermath.length, 4);
  assert.doesNotMatch(JSON.stringify(j.case), /"src"|news\.example\.com\/(flow|people)/, "학생에게는 출처 ID·근거 주소가 가지 않는다(사례 링크는 예외)");
  // 꼭 있어야 하는 '주민' 인물을 고른 학생은 다른 인물로 바꿀 수 없다(모둠에 다른 주민 인물이 없으면)
  await api.choosePersona({ auth: { uid: "S1", token: {} }, data: { code, personaId: "p1" } });
  await rejects(api.choosePersona({ auth: { uid: "S1", token: {} }, data: { code, personaId: "p6" } }), /조선소 곁에 사는 주민 인물을 맡은 친구가/);
  const out = await api.aiRequest({ auth: { uid: "S1", token: {} }, data: { code, stage: 1, type: "persona_chat", payload: { message: "요즘 무슨 일을 하세요?" } } });
  assert.equal(out.result, "음… 저는 일한 만큼 받으면 좋겠어요.");
  const chat = calls.filter((x) => x.kind === "chat").pop();
  assert.match(chat.body.messages[0].content, /지금은 2025년 3월 초다/);
  assert.match(chat.body.messages[0].content, /'김민수'/);
  assert.doesNotMatch(chat.body.messages[0].content, /예멘/);
  const guard = calls.filter((x) => x.kind === "guard").pop();
  assert.match(guard.body.messages[0].content, /거제 조선소 하청 노동/);
});

test("검토 화면에서 고친 주제 저장: 모르는 칸은 버리고, 주소를 바꾼 출처는 원문 확인이 풀리며, 수업 사본은 '최신으로 바꾸기'로만 바뀐다", async () => {
  const t = await topics(teacher, { action: "get", topicId: tid });
  const f = JSON.parse(JSON.stringify(t.file));
  f.PERSONAS[1].letter[0] = `안녕하세요. 저는 ${f.PERSONAS[1].name}이에요. 선생님이 고친 편지예요. 거제 바닷가에서 작은 가게를 하며 살아요. 학생들을 만나서 반가워요.`;
  f.PERSONAS[1].hacker = "<script>";
  f.EVENT.id = "jeju2018";
  const sid = Object.keys(f.SOURCES)[0];
  f.SOURCES[sid].url = "https://news.example.com/changed";
  f.SOURCES.XX = { title: "새 출처", outlet: "가짜", url: "https://x.example", verified: true };
  const r = await topics(teacher, { action: "save", topicId: tid, file: f });
  assert.match(r.file.PERSONAS[1].letter[0], /선생님이 고친 편지/);
  assert.equal(r.file.PERSONAS[1].hacker, undefined);
  assert.equal(r.file.EVENT.id, tid, "사건 ID 는 바꿀 수 없다");
  assert.equal(r.file.SOURCES.XX, undefined, "새 출처 ID 는 받지 않는다");
  assert.equal(r.file.SOURCES[sid].verified, false, "주소를 바꾸면 다시 확인해야 한다");
  assert.equal(r.file.SOURCES[Object.keys(f.SOURCES)[1]].verified, true);
  // 수업 사본은 그대로다가, 최신으로 바꾸면 고친 편지가 학생에게 보인다
  const before = await api.getCase({ auth: { uid: "S1", token: {} }, data: { code } });
  assert.doesNotMatch(before.letters[1].letter[0], /선생님이 고친 편지/);
  await topics(teacher, { action: "verifySource", topicId: tid, sourceIds: [sid] });
  await topics(teacher, { action: "syncSession", code });
  const after = await api.getCase({ auth: { uid: "S1", token: {} }, data: { code } });
  assert.match(after.letters[1].letter[0], /선생님이 고친 편지/);
  await rejects(topics(other, { action: "syncSession", code }), /내가 만든 수업이 아닙니다/);
});

test("주제 파일: 다 만든 주제를 내보내고 다른 교사가 불러오면, 출처는 모두 '확인 전'이고 다시 확인해야 수업에 쓴다", async () => {
  const src = await topics(teacher, { action: "get", topicId: tid });
  const x = await topics(teacher, { action: "export", topicId: tid });
  assert.equal(x.format, "ai-eps-topic");
  assert.equal(x.version, 1);
  assert.equal(x.file.PERSONAS.length, src.file.PERSONAS.length);
  assert.doesNotMatch(JSON.stringify(x), /"verified"|"verifiedAt"|"facts"/, "확인 표시·사실 은행 연결은 파일에 넣지 않는다");
  assert.ok(Object.values(x.file.SOURCES).some((s) => s.authorVerified));
  await rejects(topics(other, { action: "export", topicId: tid }), /내가 만든 주제가 아닙니다/);

  // 파일을 고쳐 '확인함'으로 바꾸거나 모르는 출처를 넣어도 받아 주지 않는다. 새 주제 만들기가 닫혀 있어도 불러올 수 있다.
  const bad = JSON.parse(JSON.stringify(x));
  Object.values(bad.file.SOURCES).forEach((s) => { s.verified = true; });
  bad.file.SOURCES.X1 = { title: "가짜", url: "https://evil.example/" };
  bad.file.EVENT.id = "jeju2018";
  process.env.TOPIC_BUILDER_ENABLED = "false";
  let t;
  try { t = await topics(other, { action: "import", data: JSON.stringify(bad) }); } finally { process.env.TOPIC_BUILDER_ENABLED = "true"; }
  assert.notEqual(t.id, tid);
  assert.equal(t.file.EVENT.id, t.id);
  assert.equal(t.title, src.file.EVENT.title);
  assert.equal(t.build.step, "review");
  assert.ok(t.imported.at);
  assert.equal(t.research, null);
  assert.equal(t.usable, 0);
  assert.equal(t.check.errors.length, 0);
  assert.deepEqual(Object.keys(t.file.SOURCES).sort(), Object.keys(src.file.SOURCES).sort());
  assert.ok(Object.values(t.file.SOURCES).every((s) => s.verified === false));
  assert.ok(Object.entries(x.file.SOURCES).every(([id, s]) => !s.authorVerified || t.file.SOURCES[id].check.startsWith("[만든 사람이 확인함]")));
  assert.equal(store.get(`teacherTopics/${t.id}`).ownerUid, "T2");

  await rejects(api.createSession({ ...other, data: { topicId: t.id, groupCount: 2 } }), /원문 확인을 마친 인물이 없습니다/);
  await rejects(topics(other, { action: "regenPersona", topicId: t.id, personaId: t.file.PERSONAS[0].id }), /불러온 주제는 AI로 다시 만들 수 없어요/);
  const v = await topics(other, { action: "verifySource", topicId: t.id, sourceIds: Object.keys(t.file.SOURCES) });
  assert.equal(v.usable, src.usable);
  const { code: c2 } = await api.createSession({ ...other, data: { topicId: t.id, groupCount: 2 } });
  assert.equal(store.get(`sessions/${c2}`).topicId, t.id);
  // 불러온 주제도 고쳐 저장하고 다시 내보낼 수 있다
  const re = await topics(other, { action: "export", topicId: t.id });
  assert.equal(re.file.PERSONAS.length, x.file.PERSONAS.length);
  await topics(other, { action: "delete", topicId: t.id });
});

test("주제 파일: 형식이 다르거나 읽을 수 없는 파일, 인물이 없는 파일은 받지 않고, 주제 수 한도를 지킨다", async () => {
  await rejects(topics(other, { action: "import", data: "{이건 JSON이 아니다" }), /읽지 못했어요/);
  await rejects(topics(other, { action: "import", data: { format: "something", version: 1, file: {} } }), /AI-EPS 주제 파일이 아니에요/);
  await rejects(topics(other, { action: "import", data: { format: "ai-eps-topic", version: 99, file: {} } }), /버전/);
  await rejects(topics(other, { action: "import", data: { format: "ai-eps-topic", version: 1, file: { EVENT: { title: "빈 주제" }, PERSONAS: [] } } }), /인물이 없어요/);
  await rejects(topics(other, { action: "import", data: "x".repeat(1024 * 1024 + 1) }), /너무 커요/);
  const x = await topics(teacher, { action: "export", topicId: tid });
  const T3 = { auth: { uid: "T3", token: { email: "c@school.kr", firebase: { sign_in_provider: "password" } } } };
  store.set("teacherAccounts/T3", { email: "c@school.kr" });
  for (let i = 0; i < 30; i++) store.set(`teacherTopics/t3${String(i).padStart(9, "0")}`, { ownerUid: "T3", title: "x" });
  await rejects(topics(T3, { action: "import", data: x }), /30개까지/);
  await rejects(topics(teacher, { action: "export", topicId: "t0000000000" }), /주제를 찾을 수 없습니다/);
});

test("교사: 내 수업·내 주제의 인물 점검을 보고, 원본 주제를 지워도 수업과 복제 수업은 그대로다", async () => {
  const a = await api.getCase({ ...teacher, data: { code, admin: true } });
  assert.equal(a.custom, true);
  assert.equal(a.personas.length, 9);
  assert.ok(a.personas[0].sources.every((s) => s.verified));
  const b = await api.getCase({ ...teacher, data: { topicId: tid } });
  assert.equal(b.event.id, tid);
  await rejects(api.getCase({ ...other, data: { topicId: tid } }), /내가 만든 주제가 아닙니다/);
  await rejects(api.getCase({ ...other, data: { code, admin: true } }), /내가 만든 수업이 아닙니다/);
  const ov = await api.savePersonaOverride({ ...teacher, data: { code, personaId: "p2", fields: { voice: "아주 밝은 해요체로 말한다." } } });
  assert.equal(ov.overrides.p2.voice, "아주 밝은 해요체로 말한다.");
  await topics(teacher, { action: "delete", topicId: tid });
  assert.equal(store.get(`teacherTopics/${tid}`), undefined);
  assert.equal(store.get(`teacherTopics/${tid}/parts/research`), undefined);
  const g = await api.getCase({ auth: { uid: "S1", token: {} }, data: { code } });
  assert.equal(g.letters.length, 9, "지운 뒤에도 수업 사본으로 계속된다");
  const cl = await api.cloneSession({ ...teacher, data: { code } });
  assert.equal(store.get(`sessions/${cl.code}`).topicId, tid);
  assert.equal(store.get(`sessions/${cl.code}/private/topic`).topicId, tid);
  await rejects(topics(teacher, { action: "syncSession", code }), /주제를 찾을 수 없습니다/);
});

test("하루에 새로 만들 수 있는 주제는 3개이고, 다른 교사의 수와는 따로 센다", async () => {
  const cand = { title: "직접 쓴 사건", summary: "교사가 직접 적은 사건 요약입니다. 스무 글자를 넘깁니다." };
  await topics(teacher, { action: "start", candidate: cand });
  await topics(teacher, { action: "start", candidate: cand });
  await rejects(topics(teacher, { action: "start", candidate: cand }), /하루 3개까지/);
  const o = await topics(other, { action: "start", candidate: cand });
  assert.equal(o.usage.topics, 1);
  await rejects(topics(teacher, { action: "start", candidate: { title: "x", summary: "짧다" } }), /20자 이상/);
});

test(".env 에 지원이 끝나는 옛 모델 이름(gpt-5 등)이 남아 있으면 그 자리의 새 기본 모델로 바꿔 쓴다", async () => {
  const r = await api.healthCheck({ ...teacher, data: {} });
  const roleOf = (m) => r.models.find((x) => x.model === m)?.roles || [];
  assert.ok(roleOf("gpt-5.6-terra").includes("1단계 인물 대화"));
  assert.ok(roleOf("gpt-5.6-terra").includes("감독자"));
  assert.ok(roleOf("gpt-5.6-terra").includes("5단계 시뮬레이션"));
  assert.ok(roleOf("gpt-5.6-sol").includes("4단계 검토") && roleOf("gpt-5.6-sol").includes("내 주제 만들기"));
  assert.ok(!r.models.some((m) => /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(m.model)), "옛 모델로는 부르지 않는다");
  // 인물 대화도 새 모델로 불렸다
  assert.ok(calls.filter((c) => c.kind === "chat").every((c) => c.body.model === "gpt-5.6-terra"));
});

test("새 주제 만들기 스위치가 꺼져 있으면 AI 단계는 막히고, 목록·저장 같은 것은 그대로 되며 list 가 알려 준다", async () => {
  process.env.TOPIC_BUILDER_ENABLED = "false";
  try {
    for (const action of ["ideas", "start", "research", "frame", "personas", "extras", "review", "regenPersona"])
      await rejects(topics(teacher, { action, idea: "x", topicId: "t0000000000" }), /잠시 닫혀/);
    const r = await topics(teacher, { action: "list" });
    assert.equal(r.builderOpen, false);
  } finally { process.env.TOPIC_BUILDER_ENABLED = "true"; }
});
