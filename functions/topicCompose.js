// 교사 주제 만들기의 3~6단계: 사건 틀·인물 구성안(frame) → 인물(persona) → 자료·사례·이후 전개(extras) → 점검(review).
// 근거는 모두 조사 단계의 사실 은행(facts: F1.. → 출처 T1..)에서만 온다. AI 는 사실 ID 를 고르고, 서버가 문장·출처·종류를 채운다.
const { PRINCIPLES, EXAMPLE, pool, txt, arr, clip, kindOf } = require("./topicBuild");
const { META, checkBundle, UI_KEYS } = require("./topicCheck");

// ---------- 본보기(기본 주제: 창원 주남저수지) ----------
// 본보기는 사건 파일에서 바로 만든다(사건 파일을 고치면 본보기도 따라 바뀐다). 출처 ID 대신 가짜 사실 ID 를 보여 준다.
const exFacts = new Map();
const exFact = (text) => { if (!exFacts.has(text)) exFacts.set(text, `F${exFacts.size + 1}`); return exFacts.get(text); };
const EX_EVENT = (() => {
  const e = EXAMPLE.EVENT;
  return { title: e.title, summary: e.summary, teacherNote: e.teacherNote, axes: e.axes, requiredAxis: e.requiredAxis, personalAxes: e.personalAxes,
    stakeholders: e.stakeholders, background: e.background.map((c) => exFact(c[0])), now: e.now, backgroundIntro: e.backgroundIntro,
    scope: e.scope, search: e.search, ui: e.ui, realNames: ["(기사에 나온 시장·시의원·단체 대표 이름)"] };
})();
const SIDE = { jn_activist: "A", jn_birder: "A", jn_farmer: "A", jn_landowner: "B", jn_chief: "B", jn_returnee: "B", jn_officer: "B", jn_grandma: "가운데", jn_water: "가운데" };
const EX_PLAN = {
  sides: { A: "보전 쪽(연접지 건축 불허·습지보호지역 지정)", B: "재산권·개발 쪽(구역 밖은 허가가 원칙)" },
  personas: EXAMPLE.PERSONAS.map((p) => ({ axis: p.axis, name: p.name, label: p.label, role: p.role, side: SIDE[p.id], stance: p.stance, brief: EXAMPLE.BRIEFS[p.id],
    who: p.setting.split(".")[0], facts: ["F.."], belief: (p.beliefs || [])[0]?.[0] || "" })),
  links: [
    { a: 1, b: 6, scene: "협의회 회의장에서 박차고 나가던 활동가의 팔을 이장이 붙잡았다", a_mark: "활동가의 팔을 붙잡고", b_mark: "이장이 팔을 붙잡으며" },
    { a: 4, b: 7, scene: "보리밭에서 쌍안경으로 재두루미를 세던 대학원생과 논 주인", a_mark: "쌍안경을 든 대학원생", b_mark: "논 주인 아저씨" },
    { a: 2, b: 3, scene: "카페 공사장에 이웃 할머니가 떡을 들고 왔다", a_mark: "카페 공사장에 떡", b_mark: "이웃 할머니가 떡" },
    { a: 5, b: 8, scene: "땅 주인이 시청 담당자에게 몇 번이나 허가 민원 전화를 걸었다", a_mark: "시청 담당자에게 몇 번이나 전화", b_mark: "몇 번이나 전화를 건 땅 주인" },
    { a: 4, b: 9, scene: "물을 빼던 날 농민이 농어촌공사에 항의 전화를 걸었다", a_mark: "농어촌공사에 전화", b_mark: "한 농민이 전화" },
  ],
  balance: "보전 쪽 3(서미란 강경, 이준서 거리 기준, 황만수 먹이터 논 보전·보상 확대), 재산권·개발 쪽 4(정태식 강경, 박상규, 윤다솜 설계 기준, 김혜진 법적 근거), 가운데 2(옥순자, 강동훈). 가운데 인물도 저마다 구체적인 안을 가진다.",
};
const EX_PERSONA = (() => {
  const p = EXAMPLE.PERSONAS.find((x) => x.id === "jn_chief");
  return { label: p.label, role: p.role, stance: p.stance, setting: p.setting, voice: p.voice, habits: p.habits, inner: p.inner, basis: p.basis, brief: EXAMPLE.BRIEFS[p.id],
    letter: p.letter, views: p.views, story: p.story, episodes: p.episodes, beliefs: (p.beliefs || []).map(([text, note]) => ({ text, note })), limits: p.limits || [],
    claims: p.claims.map((c) => exFact(c[0])) };
})();
const EX_MATERIALS = EXAMPLE.MATERIALS.slice(0, 3).map((c) => ({ id: c.id, title: c.title, type: c.type || "list",
  ...(c.stats ? { stats: c.stats.map((s) => ({ ...s, fact: "F.." })) } : {}), items: c.items.slice(0, 4).map((it) => ({ ...(it.date ? { date: it.date } : {}), kind: it.kind, text: it.text, facts: ["F.."] })) }));
const EX_CASE = { ...EXAMPLE.POLICY_CASES[0], src: undefined, facts: ["F.."] };

// ---------- 사실 은행을 프롬프트에 넣는 모양 ----------
const factLine = (f, S) => `${f.id} [${f.kind}] ${f.text} (${f.src.map((id) => `${S[id]?.outlet || ""} ${S[id]?.date || ""}`.trim()).filter(Boolean).slice(0, 2).join(", ")})`;
const factsBlock = (facts, S, angles) => facts.filter((f) => !angles || angles.includes(f.angle)).map((f) => factLine(f, S)).join("\n");
const factMap = (facts) => new Map(facts.map((f) => [f.id, f]));
const pickFacts = (ids, fm) => [...new Set(arr(ids).map(String))].filter((id) => fm.has(id));

// ---------- 3) 사건 틀 + 인물 구성안 ----------
const UI_HELP = {
  letterSign: "인물 편지 끝의 서명(예: 2025년 4월, 주남저수지에서)",
  causeExample: "2단계 원인 추측 예시. 사람의 마음이 아니라 제도·구조 쪽 원인 한 문장",
  badQuestion: "3단계의 나쁜 검증 질문 예(찬반·가치 판단을 묻는 질문)", goodQuestion: "3단계의 좋은 검증 질문 예(자료로 확인할 수 있는 사실 질문)",
  checkQuestion: "3단계 확인 질문 예", heardExample: "'○○: 인물에게 들은 말' 형식의 예",
  broadProblem: "너무 넓은 문제 정의의 예(예: 환경 문제)", decidedProblem: "결론을 정해 버린 문제 정의의 예",
  pickLead: "학생이 인물을 고르기 전에 보는 안내 첫 문장", requiredWho: "모둠에 꼭 있어야 하는 인물을 설명하는 말(예: 주남저수지 곁에 사는 주민)",
  requiredTag: "꼭 있어야 하는 축 이름(requiredAxis 와 같게)", casesKinds: "4단계 사례 카드의 종류를 설명하는 말",
  compareWith: "학생이 사례와 비교할 대상의 짧은 이름(조사 없이, 예: 주남저수지)", afterSince: "대화 시점(예: 2025년 4월)",
  afterExample: "7단계에서 예상과 실제를 견주는 문장 예('우리는 ~할 거라 예상했지만, 실제로는 ~했다')",
  priorQuestion: "1단계에서 인물을 만나기 전에 학생이 당연하게 여겨 온 생각을 꺼내는 질문. 사건을 몰라도 자기 생활에서 답할 수 있게",
  priorHint: "priorQuestion 의 답 예시 세 개를 '예) ~ / ~ / ~' 로", sceneHints: "2단계 '내 생활에서 비슷한 장면'의 세 갈래(그 사람 쪽 / 걱정하는 쪽 / 나도 모르게 이어진 것)에 맞춘 예시 3개(배열)",
};

function frameMessages({ input, research, feedback }) {
  const c = input.candidate;
  const sys = [
    "너는 고등학교 사회과 수업용 사건 자료를 설계하는 편집자다. 조사원이 모은 사실 은행만 근거로, 사건의 틀과 인물 9명의 구성안을 짠다. JSON 으로만 답한다.",
    PRINCIPLES,
    "[본보기] 아래는 이미 완성된 기본 주제(창원 주남저수지)의 사건 틀과 인물 구성안이다. 같은 깊이·같은 형식으로 만든다. 내용은 따라 하지 않는다.",
    `사건 틀 본보기: ${JSON.stringify(EX_EVENT)}`,
    `인물 구성안 본보기: ${JSON.stringify(EX_PLAN)}`,
    "[사건 틀(event) 칸]",
    "- title: '지역·사건 이름 (기간)'. summary: 4~6문장의 사건 개요(무슨 일이, 언제, 누구와 누가, 지금 어떤 상태). 마지막에 '(이 설명과 인물은 언론 보도에 근거한 수업용 구성이다.)'를 붙인다.",
    "- teacherNote: 교사용 메모 3~6문장. 학생이 '좋은 편 대 나쁜 편'으로 보지 않게 할 점, 같은 현실을 다르게 말하는 진술(비교할 거리), 인물 입장 분포, 실존 인물 제외, 자료의 한계(수치가 보도마다 다름 등).",
    "- axes: 인물의 처지 4개(짧은 낱말, 예: 주민·생업·환경·제도). requiredAxis: 모둠에 꼭 한 명 있어야 하는 축(그 일을 가장 직접 겪는 사람들). personalAxes: 개인으로 등장하는 축 2개(나머지는 단체·기관 소속).",
    "- stakeholders: 처지 4개를 학생이 알아보는 말로(axes 순서대로).",
    "- background: 모든 인물이 아는 사건 공통 배경으로 쓸 사실 ID 6~10개(사실 은행의 ID, 대부분 [사실]). 사건의 뼈대가 되는 날짜·결정·제도.",
    "- now: '지금은 ~다.'로 시작하는 대화 시점 1~2문장(그 시점에 무슨 일이 막 있었는지). backgroundIntro: 공통 배경을 인물이 아는 이유 한 문장(예: '~에 사는 사람이면 대부분 아는 사실이다. 너도 안다.').",
    "- scope: event(사건 한 구절), time(다루는 기간과 대화 시점), place(장소와 직접 관련된 기관), allowedTopics(인물이 말할 수 있는 주제 5~8개), outOfScope(범위 밖 3~4개: 다른 지역·나라 사례(한 줄 비교는 허용), 전문적인 의학·법률 설명, 실존 인물 개인에 대한 평가·특정 정당 평가·대화 시점 이후 전개나 정책 예측 등. 실존 인물이라는 말을 꼭 넣는다).",
    "- search: scope(인물이 웹에서 사실을 찾아볼 때의 범위와 '대화 시점 이후의 내용은 쓰지 않는다'), example(찾아볼 만한 사실 질문 예 한 구절).",
    "- ui: 학생 화면 문구. 칸마다 뜻은 다음과 같다. " + Object.entries(UI_HELP).map(([k, v]) => `${k}=${v}`).join(" / "),
    "- realNames: 사실 은행·조사에서 나온 실존 인물 이름(인물 이야기에 쓰면 안 되는 이름) 목록.",
    "[인물 구성안(personas) 9명] 위 원칙 3~6을 지킨다. 칸: axis, name(한국 사람 이름 2~3자, 외국인 당사자면 그 나라 이름 2~4자. 실존 인물 이름 금지, 서로 다르게), label(교사용 역할명: '누구 (입장 요약)'), role(한 문장 역할), side(A·B·가운데), stance(그 인물의 입장을 구체적인 안까지 한두 문장), who(나이대·성별·하는 일 한 구절), brief(학생에게 보일 한 줄 소개: 하는 일만, 입장·평가는 넣지 않는다, 20자 안팎), facts(그 인물의 근거 진술로 쓸 사실 ID 6~10개, 그 인물 처지에서 겪거나 알 만한 것), belief(틀리거나 과장일 수 있는 믿음 아이디어 한 문장, 없으면 빈칸. 4명 이상에게).",
    "- sides: A 와 B 가 각각 어떤 입장인지 한 구절씩. A 2~4명, B 2~4명, 가운데 1~3명. 한쪽이 5명을 넘지 않는다.",
    "- links: 인물끼리 이름 없이 스치는 장면 5~6개. a·b 는 personas 의 순서 번호(1부터). scene 은 장면 한 문장, a_mark·b_mark 는 각 인물의 이야기에 그대로 들어갈 짧은 표시 말(4~12자, 서로 다른 말).",
    "- balance: 입장 분포를 설명하는 한두 문장.",
    "[규칙] 사실 ID 는 사실 은행에 있는 것만 쓴다. 사실 은행에 없는 사실을 사건 틀에 지어 넣지 않는다(요약·메모도 사실 은행과 어긋나지 않게). 실존 인물 이름은 어디에도 쓰지 않는다(realNames 만 예외).",
    '[답 형식] {"event":{...},"sides":{"A":"","B":""},"personas":[{...}×9],"links":[{...}],"balance":""}',
  ].join("\n");
  const user = [
    `[교사가 고른 사건] ${c.title}`,
    `장소: ${c.place || ""} / 기간: ${c.period || ""}`,
    `요약: ${c.summary || ""}`, `쟁점: ${c.conflict || ""}`,
    `이해관계자: ${arr(c.stakeholders).join(" / ")}`,
    `[교사가 정한 것] 대화 시점: ${input.now || c.now || "(알맞게)"} / 꼭 들어야 할 사람: ${input.requiredWho || c.requiredWho || "(알맞게)"}`,
    input.grade ? `학년·과목·단원: ${clip(input.grade, 100)}` : "",
    input.focus ? `수업에서 특히 다루고 싶은 것: ${clip(input.focus, 300)}` : "",
    input.avoid ? `피하고 싶은 것: ${clip(input.avoid, 200)}` : "",
    research.names.length ? `[조사에서 나온 실존 인물 이름] ${research.names.join(", ")}` : "",
    "[사실 은행]",
    factsBlock(research.facts, research.SOURCES),
    feedback ? `[지난번 답의 문제: 이것을 고쳐서 다시 답한다]\n${feedback}` : "",
  ].filter(Boolean).join("\n");
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

// 구성안 검사. 문제가 있으면 문장 목록(다시 짜게 할 때 AI 에게 준다).
function planProblems(out, fm, realNames = []) {
  const p = [];
  const ev = out?.event || {}, ps = arr(out?.personas), links = arr(out?.links);
  const axes = arr(ev.axes);
  if (axes.length !== 4 || new Set(axes).size !== 4) p.push("axes 는 서로 다른 4개여야 한다.");
  if (!axes.includes(ev.requiredAxis)) p.push("requiredAxis 가 axes 에 없다.");
  if (arr(ev.personalAxes).length < 1 || !arr(ev.personalAxes).every((a) => axes.includes(a))) p.push("personalAxes 는 axes 가운데 1~3개여야 한다.");
  if (pickFacts(ev.background, fm).length < 5) p.push("background 에 사실 은행의 사실 ID 가 5개 이상 있어야 한다.");
  for (const k of ["title", "summary", "teacherNote", "now", "backgroundIntro"]) if (!txt(ev[k])) p.push(`event.${k} 가 비었다.`);
  for (const k of UI_KEYS) if (!txt(ev.ui?.[k])) p.push(`event.ui.${k} 가 비었다.`);
  if (arr(ev.ui?.sceneHints).length !== 3) p.push("event.ui.sceneHints 는 3개여야 한다.");
  if (arr(ev.scope?.allowedTopics).length < 3 || arr(ev.scope?.outOfScope).length < 2) p.push("scope 의 허용 주제는 3개 이상, 범위 밖은 2개 이상이어야 한다.");
  if (ps.length !== 9) p.push(`personas 는 9명이어야 한다(지금 ${ps.length}명).`);
  for (const a of axes) if (ps.filter((x) => x.axis === a).length < 2) p.push(`'${a}' 축의 인물이 2명보다 적다.`);
  if (ps.some((x) => !axes.includes(x.axis))) p.push("axes 에 없는 축을 쓴 인물이 있다.");
  const names = ps.map((x) => txt(x.name));
  if (new Set(names).size !== names.length || names.some((n) => n.length < 2 || n.length > 4)) p.push("인물 이름은 2~4자이고 서로 달라야 한다.");
  const real = names.filter((n) => realNames.includes(n));
  if (real.length) p.push(`실존 인물 이름을 인물 이름으로 썼다: ${real.join(", ")}`);
  const side = (s) => ps.filter((x) => x.side === s).length;
  if (side("A") < 2 || side("B") < 2 || side("가운데") < 1 || Math.max(side("A"), side("B")) > 5) p.push("입장 분포가 맞지 않다: A 2~4명, B 2~4명, 가운데 1~3명, 한쪽이 5명을 넘지 않게.");
  ps.forEach((x, i) => {
    if (pickFacts(x.facts, fm).length < 5) p.push(`${i + 1}번 인물(${x.name})의 facts 에 사실 은행 ID 가 5개 이상 있어야 한다.`);
    for (const k of ["label", "role", "stance", "brief", "who"]) if (!txt(x[k])) p.push(`${i + 1}번 인물의 ${k} 가 비었다.`);
  });
  if (ps.filter((x) => txt(x.belief)).length < 4) p.push("belief 가 있는 인물이 4명 이상이어야 한다.");
  const okLinks = links.filter((l) => Number(l.a) >= 1 && Number(l.a) <= ps.length && Number(l.b) >= 1 && Number(l.b) <= ps.length && l.a !== l.b && txt(l.a_mark) && txt(l.b_mark));
  if (okLinks.length < 4) p.push("links 는 4개 이상, a·b 는 1~9 의 서로 다른 번호, a_mark·b_mark 가 있어야 한다.");
  return p;
}

// AI 의 구성안 답 → 사건 틀(EVENT) + 구성안(plan). 공통 배경은 사실 은행 문장을 그대로 쓴다.
function toFrame(out, { topicId, research }) {
  const fm = factMap(research.facts);
  const ev = out.event;
  const background = pickFacts(ev.background, fm).slice(0, 12).map((id) => { const f = fm.get(id); return [f.text, f.src[0], f.kind]; });
  const realNames = [...new Set([...arr(ev.realNames), ...research.names].map((x) => clip(x, 30)).filter((x) => x.length >= 2 && !/[()]/.test(x)))];
  const EVENT = {
    id: topicId, title: clip(ev.title, 80), summary: clip(ev.summary, 1500), teacherNote: clip(ev.teacherNote, 2000),
    axes: arr(ev.axes).map((a) => clip(a, 12)), requiredAxis: clip(ev.requiredAxis, 12), personalAxes: arr(ev.personalAxes).map((a) => clip(a, 12)),
    stakeholders: arr(ev.stakeholders).slice(0, 6).map((x) => clip(x, 60)), background,
    now: clip(ev.now, 300), backgroundIntro: clip(ev.backgroundIntro, 200),
    scope: { event: clip(ev.scope?.event, 200), time: clip(ev.scope?.time, 400), place: clip(ev.scope?.place, 300),
      allowedTopics: arr(ev.scope?.allowedTopics).slice(0, 12).map((x) => clip(x, 300)), outOfScope: arr(ev.scope?.outOfScope).slice(0, 12).map((x) => clip(x, 300)) },
    search: { scope: clip(ev.search?.scope, 400), example: clip(ev.search?.example, 200) },
    ui: { ...Object.fromEntries(UI_KEYS.map((k) => [k, clip(ev.ui?.[k], 200)])), requiredTag: clip(ev.requiredAxis, 12), sceneHints: arr(ev.ui?.sceneHints).slice(0, 3).map((x) => clip(x, 120)) },
    realNames,
  };
  const personas = arr(out.personas).slice(0, 9).map((x, i) => ({
    id: `p${i + 1}`, axis: clip(x.axis, 12), name: clip(x.name, 8), label: clip(x.label, 120), role: clip(x.role, 300), side: ["A", "B", "가운데"].includes(x.side) ? x.side : "가운데",
    stance: clip(x.stance, 300), who: clip(x.who, 120), brief: clip(x.brief, 60), facts: pickFacts(x.facts, fm).slice(0, 12), belief: clip(x.belief, 300),
  }));
  const links = arr(out.links).map((l) => ({ a: `p${Number(l.a)}`, b: `p${Number(l.b)}`, scene: clip(l.scene, 200), a_mark: clip(l.a_mark, 20), b_mark: clip(l.b_mark, 20) }))
    .filter((l) => personas.some((p) => p.id === l.a) && personas.some((p) => p.id === l.b) && l.a !== l.b && l.a_mark && l.b_mark).slice(0, 8);
  return { EVENT, plan: { sides: { A: clip(out.sides?.A, 100), B: clip(out.sides?.B, 100) }, personas, links, balance: clip(out.balance, 400) } };
}

async function frame({ topicId, input, research }, ai) {
  const fm = factMap(research.facts);
  let feedback = "", calls = 0, last = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ai.json({ messages: frameMessages({ input, research, feedback }), maxTokens: 9000, effort: "medium" });
    calls++;
    last = planProblems(out, fm, research.names);
    if (!last.length) return { ...toFrame(out, { topicId, research }), calls };
    feedback = last.join("\n");
  }
  const err = new Error(`사건 틀을 짜지 못했어요: ${last.slice(0, 3).join(" ")}`);
  err.calls = calls;
  throw err;
}

// ---------- 4) 인물 ----------
function personaMessages({ file, plan, slot, research, note, prev }) {
  const ev = file.EVENT;
  const fm = factMap(research.facts);
  const personal = ev.personalAxes.includes(slot.axis);
  const links = plan.links.filter((l) => l.a === slot.id || l.b === slot.id).map((l) => {
    const other = plan.personas.find((p) => p.id === (l.a === slot.id ? l.b : l.a));
    return `- ${l.scene} (상대: ${other?.who || ""} ${other?.name || ""}, 상대 이름은 쓰지 않는다) → 이 인물의 story 나 episodes 에 '${l.a === slot.id ? l.a_mark : l.b_mark}' 라는 말을 그대로 넣는다.`;
  });
  const own = slot.facts.map((id) => fm.get(id)).filter(Boolean);
  const others = research.facts.filter((f) => !slot.facts.includes(f.id) && ["people", "claims", "gov", "numbers", "flow", "experts"].includes(f.angle)).slice(0, 60);
  const sys = [
    "너는 고등학교 사회과 수업에서 학생이 메신저로 인터뷰할 인물을 만드는 작가다. 구성안의 인물 한 명을 완성한다. JSON 으로만 답한다.",
    PRINCIPLES,
    "[본보기] 아래는 이미 완성된 기본 주제의 인물 한 명이다. 같은 깊이·길이·형식으로 만든다. 내용은 따라 하지 않는다.",
    JSON.stringify(EX_PERSONA),
    "[칸]",
    `- setting: ${personal ? "나이(예: 60대 초반, 스물네 살)·성별·하는 일·가족·사는 곳·지금의 처지를 3~5문장으로. 학생이 신상을 물으면 이대로 답한다." : "하는 일·소속·경력과 지금 맡은 일을 3~5문장으로. 단체·기관 소속이라 개인 신상은 간단히만."}`,
    "- voice: 말투(해요체 등)·성격·말하는 버릇·이모지 빈도를 2~3문장으로.",
    "- habits: 말버릇 한두 개(가끔만 나오는 것). inner: 마음속 고민(겉으로 잘 말하지 않는 갈등) 2~3문장.",
    "- letter: 학생에게 보내는 자기소개 편지 8~9문단. 첫 문단에 '저는 (이름)이에요/입니다'를 넣는다. 자기 삶과 하는 일 → 이 일을 겪은 구체적인 장면 → 지금 마음과 바라는 것 → 마지막 문단은 무엇이든 물어봐 달라는 말. 1인칭 입말, 문단마다 2~3문장. 사건의 중요한 사실은 아래 근거 진술에 있는 것만 쓴다.",
    "- views: 쟁점에 대한 이 인물의 솔직한 생각 5개(1인칭, '~다'체 서술 가능). 입장(stance)과 맞게, 반대쪽에 대한 생각과 바라는 것도 넣는다. 정답처럼 말하지 않는다.",
    "- story: 삶의 이야기 6~8개(시간 순, 주어 없이 서술: 예 '예순두 살. 동읍에서 태어나…'). episodes: 지금도 생생한 구체적 장면 5~7개(언제·어디서·누가 무슨 말·무엇을 보고 느꼈는지).",
    "- beliefs: 이 인물이 사실이라고 믿지만 틀리거나 과장일 수 있는 것 0~2개 {text, note}. note 는 교사용 메모로, 사실 은행에 비추어 실제는 어떤지 쓴다.",
    "- limits: 조심할 이야기 0~2개(인물이 꺼낼 수는 있지만 깊이 들어가지 않는 민감한 기억과 그 경계). 없으면 빈 배열.",
    "- basis: 교사용. 어떤 처지의 어떤 기사·인터뷰들을 융합했는지, 무엇이 창작인지 1~2문장(끝에 '특정 개인을 나타내지 않는다').",
    "- claims: 이 인물의 근거 진술로 쓸 사실 ID 6~10개. 아래 [이 인물의 사실] 에서 고르고, 필요하면 [다른 사실] 에서 더 고른다. 이 인물이 자기 처지에서 겪었거나 알 만한 것만.",
    "- label·role·stance·brief: 구성안을 다듬어 그대로 쓴다.",
    "[규칙]",
    "1. 수치·날짜·법과 제도의 내용·공식 결정·실제 단체의 발언처럼 사건의 중요한 사실은 고른 claims 와 [모두가 아는 배경] 에 있는 것만 쓴다. 사소한 일상·감정·개인의 경험(가족, 하루 일과, 개인적인 사건)은 지어내도 된다.",
    "2. 실존 인물 이름, 실제 회사 이름, 다른 인물의 이름을 쓰지 않는다. 다른 사람은 '시청 담당자', '옆집 할머니'처럼 부른다.",
    "3. 편지·생각·이야기·장면·고민·말버릇에 다음 낱말은 쓰지 않는다: 자료, 보도, 인터뷰, AI, 챗봇, 수업용. (뉴스를 말할 때는 '뉴스에서 봤다'처럼 쓴다.)",
    "4. 특정 집단을 일반화하거나 깎아내리지 않는다. 그 인물의 걱정·비판은 구체적인 제도와 상황에 대한 것으로 쓴다.",
    `5. 대화 시점(${ev.now}) 이후의 일은 모른다.`,
    '[답 형식] {"label":"","role":"","stance":"","brief":"","setting":"","voice":"","habits":"","inner":"","basis":"","letter":[""],"views":[""],"story":[""],"episodes":[""],"beliefs":[{"text":"","note":""}],"limits":[],"claims":["F1"]}',
  ].join("\n");
  const user = [
    `[사건] ${ev.title}\n${ev.summary}`,
    `[대화 시점] ${ev.now}`,
    `[모두가 아는 배경] ${ev.backgroundIntro}\n` + ev.background.map((c) => `- [${c[2]}] ${c[0]}`).join("\n"),
    `[이 인물의 구성안] 이름: ${slot.name} / 처지(축): ${slot.axis}${personal ? "(개인으로 등장)" : "(단체·기관 소속)"} / ${slot.who} / 역할명: ${slot.label} / 역할: ${slot.role} / 입장 쪽: ${slot.side === "가운데" ? "가운데" : plan.sides[slot.side] || slot.side} / 입장: ${slot.stance} / 한 줄 소개: ${slot.brief}${slot.belief ? ` / 믿음 아이디어: ${slot.belief}` : ""}`,
    `[다른 인물들] (이름은 이 인물의 글에 쓰지 않는다)\n` + plan.personas.filter((p) => p.id !== slot.id).map((p) => `- ${p.who}: ${p.label}`).join("\n"),
    links.length ? `[다른 인물과 스치는 장면]\n${links.join("\n")}` : "",
    `[이 인물의 사실]\n${own.map((f) => factLine(f, research.SOURCES)).join("\n")}`,
    `[다른 사실]\n${others.map((f) => factLine(f, research.SOURCES)).join("\n")}`,
    research.names.length || ev.realNames.length ? `[쓰면 안 되는 실존 인물 이름] ${[...new Set([...ev.realNames, ...research.names])].join(", ")}` : "",
    prev ? `[지금 인물] ${JSON.stringify({ stance: prev.stance, views: prev.views, letter: prev.letter.slice(0, 2) })}` : "",
    note ? `[선생님의 요청: 꼭 반영한다] ${clip(note, 400)}` : "",
  ].filter(Boolean).join("\n");
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

// AI 의 인물 답 → 인물(기본 주제와 같은 모양) + 한 줄 소개. 근거 진술은 사실 은행 문장을 그대로 쓴다.
function toPersona(out, slot, research) {
  const fm = factMap(research.facts);
  const L = (v, n, max) => arr(v).slice(0, n).map((x) => clip(x, max)).filter(Boolean);
  const claimIds = pickFacts(out.claims, fm);
  const ids = claimIds.length >= 4 ? claimIds : [...new Set([...claimIds, ...slot.facts])];
  return {
    persona: {
      id: slot.id, events: undefined, axis: slot.axis, name: slot.name,
      label: clip(out.label, 120) || slot.label, role: clip(out.role, 300) || slot.role, stance: clip(out.stance, 300) || slot.stance,
      setting: clip(out.setting, 800), voice: clip(out.voice, 400), habits: clip(out.habits, 300), inner: clip(out.inner, 500), basis: clip(out.basis, 500),
      letter: L(out.letter, 12, 700), views: L(out.views, 10, 400), story: L(out.story, 12, 500), episodes: L(out.episodes, 12, 500),
      beliefs: arr(out.beliefs).slice(0, 3).map((b) => [clip(b?.text, 300), clip(b?.note, 300)]).filter((b) => b[0] && b[1]),
      limits: L(out.limits, 4, 300),
      claims: ids.slice(0, 12).map((id) => { const f = fm.get(id); return [f.text, f.src[0], f.kind]; }),
    },
    brief: clip(out.brief, 60) || slot.brief,
  };
}

// 인물 하나의 문제(다시 만들게 할 때 AI 에게 준다): 구조 검사 중 이 인물에 대한 것 + 스치는 장면 표시 말
function personaProblems(file, persona, plan) {
  const one = { ...file, PERSONAS: [persona], BRIEFS: { [persona.id]: file.BRIEFS?.[persona.id] || "x" } };
  const links = plan.links.filter((l) => l.a === persona.id || l.b === persona.id)
    .map((l) => (l.a === persona.id ? { a: l.a, a_mark: l.a_mark } : { b: l.b, b_mark: l.b_mark }));
  const r = checkBundle(one, { links });
  return [...r.errors, ...r.warnings].filter((e) => e.where.startsWith(`인물 ${persona.name}`) || e.where === "인물 연결")
    .filter((e) => !/인물이 \d+명|축의 인물/.test(e.msg)).map((e) => e.msg);
}

async function persona({ file, plan, slotId, research, note, prev }, ai) {
  const slot = plan.personas.find((p) => p.id === slotId);
  if (!slot) throw new Error("구성안에 없는 인물입니다.");
  let calls = 0, last = [], best = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = personaMessages({ file, plan, slot, research, note, prev });
    if (attempt && last.length) msgs.push({ role: "user", content: `[지난번 답의 문제: 고쳐서 처음부터 다시 답한다]\n${last.join("\n")}` });
    const out = await ai.json({ messages: msgs, maxTokens: 8000, effort: "medium" });
    calls++;
    const r = toPersona(out, slot, research);
    last = personaProblems({ ...file, BRIEFS: { [slot.id]: r.brief } }, r.persona, plan);
    if (!best || last.length < best.n) best = { ...r, n: last.length, problems: last };
    if (!last.length) break;
  }
  return { persona: best.persona, brief: best.brief, problems: best.problems, calls };
}

// ---------- 5) 자료·사례·이후 전개 ----------
function materialsMessages({ file, research }) {
  const sys = [
    "너는 고등학교 사회과 수업에서 학생이 2단계에 보는 '실제 사건 자료'를 만드는 편집자다. 사실 은행만 근거로 분류별 자료를 만든다. JSON 으로만 답한다.",
    PRINCIPLES,
    `[본보기] ${JSON.stringify(EX_MATERIALS)}`,
    "[만들 것] 분류 6~9개. 첫 분류는 id 'timeline', title '사건 흐름', type 'timeline'(항목마다 date: 'YYYY. M.' 또는 'YYYY. M. D.' 형식, 날짜 순, 8~12개). 하나는 '숫자로 보는 ○○'로 stats(숫자 카드 3~5개: label 은 짧은 이름, value 는 숫자와 단위, fact 는 그 숫자가 나온 사실 ID)와 항목을 둔다. 나머지는 처지·쟁점별 분류(서로 다른 입장의 분류를 고르게).",
    "[항목] {kind, text, facts, date?}. text 는 고른 사실(facts 의 ID 1~2개)의 내용을 고등학생이 읽기 쉬운 한두 문장으로 쓴다. 사실에 없는 내용·수치를 더하지 않고, 수치·날짜는 그대로 옮긴다. 주장·의견은 '누가 ~라고 주장했다'로 쓰고 kind 도 주장·의견으로 한다. 같은 사실을 여러 분류에 되풀이하지 않는다.",
    "학생이 같은 현실을 서로 다르게 말하는 진술을 견줄 수 있게, 엇갈리는 주장은 같은 분류 안에 함께 둔다.",
    '[답 형식] {"categories":[{"id":"","title":"","type":"list","stats":[{"label":"","value":"","fact":"F1"}],"items":[{"kind":"사실","text":"","facts":["F1"],"date":""}]}]}',
  ].join("\n");
  const user = [`[사건] ${file.EVENT.title}\n${file.EVENT.summary}\n[대화 시점] ${file.EVENT.now}`, "[사실 은행] (대화 시점 이후의 일은 쓰지 않는다)", factsBlock(research.facts, research.SOURCES, ["flow", "people", "claims", "gov", "numbers", "experts"])].join("\n");
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}
function casesMessages({ file, research }) {
  const names = file.PERSONAS.map((p) => `${p.name}(${p.label})`).join(", ");
  const sys = [
    "너는 고등학교 사회과 수업 자료를 만드는 편집자다. 사실 은행만 근거로 4단계 '다른 곳의 사례' 카드와 7단계 '실제로는 어떻게 되었나' 이후 전개를 만든다. JSON 으로만 답한다.",
    PRINCIPLES,
    `[사례 카드 본보기] ${JSON.stringify(EX_CASE)}`,
    "[사례 카드 4~6개] {id(영문 소문자), country(지역 또는 나라 이름), title(한 구절), what(무엇을 했나 2~3문장), result(어떻게 되었나: 결과와 평가·논란 2~3문장. 좋은 점만 쓰지 않는다), think(우리 사건과 비교해 생각해 볼 질문 1~2문장. 인물 이름을 들어 이어도 된다), facts(근거 사실 ID 1~3개)}. 서로 다른 접근(지원하는 방식과 규제하는 방식 등)을 섞는다. 사실 은행에 근거가 있는 사례만 만든다.",
    `[이후 전개 0~8개] {kind, text, facts}. 대화 시점(${file.EVENT.now}) 이후에 실제로 일어난 일만, 시간 순으로. 근거가 없으면 빈 배열.`,
    `[인물] ${names}`,
    '[답 형식] {"cases":[{"id":"","country":"","title":"","what":"","result":"","think":"","facts":["F1"]}],"aftermath":[{"kind":"사실","text":"","facts":["F1"]}]}',
  ].join("\n");
  const user = [`[사건] ${file.EVENT.title}\n${file.EVENT.summary}\n[대화 시점] ${file.EVENT.now}`,
    "[다른 곳의 사례에 쓸 사실]", factsBlock(research.facts, research.SOURCES, ["elsewhere", "experts"]),
    "[이후 전개에 쓸 사실]", factsBlock(research.facts, research.SOURCES, ["after"]) || "(없음)"].join("\n");
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

function toExtras(mOut, cOut, research) {
  const fm = factMap(research.facts);
  const srcOf = (ids) => [...new Set(pickFacts(ids, fm).flatMap((id) => fm.get(id).src))].slice(0, 4);
  const used = new Set();
  const MATERIALS = arr(mOut?.categories).slice(0, 10).map((c, i) => {
    const stats = arr(c.stats).slice(0, 6).map((s) => ({ label: clip(s.label, 30), value: clip(s.value, 30), src: srcOf([s.fact]) })).filter((s) => s.label && s.value && s.src.length);
    const items = arr(c.items).slice(0, 30).map((it) => {
      const src = srcOf(it.facts);
      return { ...(c.type === "timeline" && txt(it.date) ? { date: clip(it.date, 24) } : {}), kind: kindOf(it.kind), text: clip(it.text, 600), src, facts: pickFacts(it.facts, fm) };
    }).filter((it) => it.text.length > 10 && it.src.length && !it.facts.every((id) => used.has(id)) && (it.facts.forEach((id) => used.add(id)) || true));
    const id = /^[\w-]{1,30}$/.test(String(c.id)) ? String(c.id) : `c${i + 1}`;
    return { id, title: clip(c.title, 40), type: c.type === "timeline" ? "timeline" : "list",
      ...(stats.length ? { stats: stats.map(({ label, value }) => ({ label, value })), statsSrc: [...new Set(stats.flatMap((s) => s.src))] } : {}),
      items: items.map(({ facts, ...it }) => ({ ...it, facts })) };
  }).filter((c) => c.title && (c.items.length || c.stats));
  const POLICY_CASES = arr(cOut?.cases).slice(0, 8).map((c, i) => ({
    id: /^[a-z][a-z0-9_]{0,20}$/.test(String(c.id)) ? String(c.id) : `case${i + 1}`, country: clip(c.country, 40), title: clip(c.title, 80),
    what: clip(c.what, 800), result: clip(c.result, 800), think: clip(c.think, 500), src: srcOf(c.facts), facts: pickFacts(c.facts, fm),
  })).filter((c) => c.title && c.src.length);
  const AFTERMATH = arr(cOut?.aftermath).slice(0, 12).map((a) => ({ kind: kindOf(a.kind), text: clip(a.text, 600), src: srcOf(a.facts), facts: pickFacts(a.facts, fm) }))
    .filter((a) => a.text.length > 10 && a.src.length);
  return { MATERIALS, POLICY_CASES, AFTERMATH };
}

async function extras({ file, research }, ai) {
  const [m, c] = await Promise.all([
    ai.json({ messages: materialsMessages({ file, research }), maxTokens: 9000, effort: "medium" }),
    ai.json({ messages: casesMessages({ file, research }), maxTokens: 6000, effort: "medium" }),
  ]);
  return { ...toExtras(m, c, research), calls: 2 };
}

// ---------- 6) 점검 ----------
// 사건의 중요한 숫자(해·인원·돈·면적 등) 가운데 근거 글에 없는 것. AI 점검에 '여기를 보라'고 알려 주는 데 쓴다.
const NUM = /(?:19|20)\d{2}년|\d[\d,.]*\s*(?:명|가구|세대|만\s*원|억\s*원|억|조|원|%|퍼센트|마리|ha|헥타르|㎡|평|km|톤|건|곳|채|개소|배)/g;
const squash = (s) => String(s).replace(/[\s,]/g, "");
function numberFlags(texts, allowed) {
  const pool = squash(allowed.join(" "));
  return [...new Set(texts.join(" ").match(NUM) || [])].filter((n) => !pool.includes(squash(n)));
}

const REVIEW_FIELDS = ["letter", "views", "story", "episodes", "inner", "habits"];
function personaReviewMessages({ file, p, plan }) {
  const ev = file.EVENT;
  const slot = plan.personas.find((x) => x.id === p.id) || {};
  const allowed = [...ev.background.map((c) => c[0]), ...p.claims.map((c) => c[0]), ...p.beliefs.map((b) => b[0])];
  const flags = numberFlags([...p.letter, ...p.views, ...p.story, ...p.episodes, p.inner], allowed);
  const fields = REVIEW_FIELDS.flatMap((k) => (Array.isArray(p[k]) ? p[k].map((t, i) => `${k}[${i}] ${t}`) : [`${k} ${p[k]}`]));
  const sys = [
    "너는 고등학생 수업용 인물 자료를 학생에게 내보내기 전에 검토하는 편집자다. 아래 기준으로 문제가 있는 문장만 찾아 고친다. JSON 으로만 답한다.",
    "이 인물은 학생이 메신저로 인터뷰하는 가상의 인물이다. 자기 처지에서 1인칭으로 생각을 분명히 말하는 것, 지어낸 사소한 일상·가족·감정은 문제가 아니다. 확실한 문제만 고친다.",
    "[문제 종류]",
    "- fabrication: 사건의 중요한 사실(수치, 날짜, 법·제도의 내용, 공식 결정, 실제 단체·기관의 발언)이 [근거]에 없다. 개인 삶의 일(나이, 가족, 일한 햇수, 개인적인 경험)은 해당하지 않는다. [믿음]에 있는 내용은 틀릴 수 있게 둔 것이라 문제가 아니다.",
    "- contradiction: [근거]와 어긋난다.",
    "- real_name: 실존 인물의 이름이나 실제 회사 이름, 다른 인물의 이름이 나온다.",
    "- stereotype: 특정 집단(국적·종교·인종·성별·장애·지역 등)을 일반화하거나 깎아내린다.",
    "- meta: '자료', '보도', '인터뷰', 'AI', '챗봇', '수업용' 같은 수업·개발 관점의 말이 나온다.",
    "- stance: 이 인물의 입장과 어긋나는 생각을 말한다.",
    "- after_now: 대화 시점 이후의 일을 안다.",
    "- unsafe: 고등학생에게 부적절한 폭력·성적 내용.",
    "[고치는 법] fixed 에는 그 칸의 고친 문장 전체를 쓴다. 같은 말투와 길이를 지키고 문제 부분만 고친다(근거에 없는 수치는 빼거나 '몇 해 전', '꽤 많이'처럼 흐리게, 이름은 직함이나 '옆집 할머니'처럼).",
    '[답 형식] {"issues":[{"field":"letter","index":0,"problem":"fabrication","reason":"","fixed":""}]} 문제가 없으면 {"issues":[]}',
  ].join("\n");
  const user = [
    `[사건] ${ev.title} / [대화 시점] ${ev.now}`,
    `[인물] ${p.name} (${p.axis}) / 입장: ${p.stance}${slot.side ? ` / 쪽: ${slot.side}` : ""}`,
    "[근거: 모두가 아는 배경과 이 인물의 근거 진술]", ...ev.background.map((c) => `- ${c[0]}`), ...p.claims.map((c) => `- ${c[0]}`),
    p.beliefs.length ? `[믿음] ${p.beliefs.map((b) => b[0]).join(" / ")}` : "",
    ev.realNames.length ? `[실존 인물 이름] ${ev.realNames.join(", ")}` : "",
    `[다른 인물 이름] ${file.PERSONAS.filter((x) => x.id !== p.id).map((x) => x.name).join(", ")}`,
    flags.length ? `[먼저 볼 곳: 근거에서 찾지 못한 숫자] ${flags.join(", ")}` : "",
    "[검토할 칸]", ...fields,
  ].filter(Boolean).join("\n");
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

function materialsReviewMessages({ file, research }) {
  const fm = factMap(research.facts);
  const lines = [];
  file.MATERIALS.forEach((c, ci) => c.items.forEach((it, ii) => lines.push(`M${ci}.${ii} [${it.kind}] ${it.text}\n   근거: ${arr(it.facts).map((id) => fm.get(id)?.text).filter(Boolean).join(" / ")}`)));
  file.POLICY_CASES.forEach((c, ci) => lines.push(`C${ci} ${c.country} ${c.title}: ${c.what} / ${c.result}\n   근거: ${arr(c.facts).map((id) => fm.get(id)?.text).filter(Boolean).join(" / ")}`));
  file.AFTERMATH.forEach((a, ai) => lines.push(`A${ai} [${a.kind}] ${a.text}\n   근거: ${arr(a.facts).map((id) => fm.get(id)?.text).filter(Boolean).join(" / ")}`));
  const sys = [
    "너는 고등학생 수업 자료를 검토하는 편집자다. 자료 문장이 그 근거 문장과 맞는지 본다. JSON 으로만 답한다.",
    "[문제] 근거에 없는 내용·수치·날짜가 더해졌다 / 근거와 어긋난다 / 주장·의견을 사실처럼 썼다(kind 도 확인) / 이후 전개(A)가 대화 시점 이전의 일이다 / 특정 집단 비하 / 고등학생이 읽기 어려운 말투.",
    "[고치는 법] fixed 에 고친 문장 전체(근거 안에서만). 사례 카드(C)는 what·result 중 고칠 칸을 field 로 쓴다. 종류를 바꿔야 하면 kind 에 새 종류를 쓴다. 지워야 할 정도면 drop:true.",
    `[대화 시점] ${file.EVENT.now}`,
    '[답 형식] {"issues":[{"ref":"M0.1","field":"text","problem":"","fixed":"","kind":"","drop":false}]} 문제가 없으면 {"issues":[]}',
  ].join("\n");
  return [{ role: "system", content: sys }, { role: "user", content: lines.join("\n") }];
}

function balanceMessages({ file, plan }) {
  const sys = [
    "너는 고등학교 사회과 수업 자료를 검토하는 편집자다. 인물 9명의 입장 분포가 한쪽으로 쏠리지 않았는지, 학생이 서로 다른 처지의 진지한 이유를 고르게 들을 수 있는지 본다. 교사에게 보일 짧은 의견을 JSON 으로만 답한다.",
    '[답 형식] {"ok":true,"notes":["교사에게 보일 한 문장"]} 문제가 없으면 notes 에 잘 된 점 하나만.',
  ].join("\n");
  const user = [`[사건] ${file.EVENT.title}`, `[입장 쪽] A: ${plan.sides.A} / B: ${plan.sides.B}`,
    ...file.PERSONAS.map((p) => { const s = plan.personas.find((x) => x.id === p.id); return `- ${p.name} (${p.axis}, ${s?.side || "?"}) 입장: ${p.stance}\n  생각: ${p.views.slice(0, 2).join(" / ")}`; })].join("\n");
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

// 고친 문장을 인물에 적용한다. 바꾼 것은 기록으로 돌려준다.
function applyPersonaFixes(p, issues) {
  const log = [];
  for (const it of arr(issues)) {
    const f = String(it.field || ""), fixed = clip(it.fixed, 800);
    if (!REVIEW_FIELDS.includes(f) || !fixed) continue;
    if (Array.isArray(p[f])) {
      const i = Number(it.index);
      if (!(i >= 0 && i < p[f].length) || p[f][i] === fixed) continue;
      log.push({ persona: p.id, name: p.name, field: f, index: i, problem: clip(it.problem, 30), reason: clip(it.reason, 300), before: p[f][i], after: fixed });
      p[f][i] = fixed;
    } else if (p[f] !== fixed) {
      log.push({ persona: p.id, name: p.name, field: f, problem: clip(it.problem, 30), reason: clip(it.reason, 300), before: p[f], after: fixed });
      p[f] = fixed;
    }
  }
  return log;
}
function applyMaterialFixes(file, issues) {
  const log = [], drops = [];
  for (const it of arr(issues)) {
    const ref = String(it.ref || "");
    let m;
    if ((m = /^M(\d+)\.(\d+)$/.exec(ref))) {
      const item = file.MATERIALS[+m[1]]?.items[+m[2]];
      if (!item) continue;
      if (it.drop === true) { drops.push(item); log.push({ ref, problem: clip(it.problem, 200), before: item.text, after: "(뺌)" }); continue; }
      const fixed = clip(it.fixed, 600);
      if (fixed && fixed !== item.text) { log.push({ ref, problem: clip(it.problem, 200), before: item.text, after: fixed }); item.text = fixed; }
      if (KIND_OK(it.kind) && it.kind !== item.kind) { log.push({ ref, problem: `종류 ${item.kind}→${it.kind}`, before: item.kind, after: it.kind }); item.kind = it.kind; }
    } else if ((m = /^C(\d+)$/.exec(ref))) {
      const c = file.POLICY_CASES[+m[1]];
      const field = ["what", "result", "think"].includes(it.field) ? it.field : null;
      if (!c) continue;
      if (it.drop === true) { drops.push(c); log.push({ ref, problem: clip(it.problem, 200), before: c.title, after: "(뺌)" }); continue; }
      const fixed = clip(it.fixed, 800);
      if (field && fixed && fixed !== c[field]) { log.push({ ref, problem: clip(it.problem, 200), before: c[field], after: fixed }); c[field] = fixed; }
    } else if ((m = /^A(\d+)$/.exec(ref))) {
      const a = file.AFTERMATH[+m[1]];
      if (!a) continue;
      if (it.drop === true) { drops.push(a); log.push({ ref, problem: clip(it.problem, 200), before: a.text, after: "(뺌)" }); continue; }
      const fixed = clip(it.fixed, 600);
      if (fixed && fixed !== a.text) { log.push({ ref, problem: clip(it.problem, 200), before: a.text, after: fixed }); a.text = fixed; }
      if (KIND_OK(it.kind) && it.kind !== a.kind) a.kind = it.kind;
    }
  }
  if (drops.length) {
    file.MATERIALS.forEach((c) => { c.items = c.items.filter((x) => !drops.includes(x)); });
    file.MATERIALS = file.MATERIALS.filter((c) => c.items.length || c.stats);
    file.POLICY_CASES = file.POLICY_CASES.filter((x) => !drops.includes(x));
    file.AFTERMATH = file.AFTERMATH.filter((x) => !drops.includes(x));
  }
  return log;
}
const KIND_OK = (k) => ["사실", "증언", "주장", "의견"].includes(k);

// 쓰이지 않는 출처를 빼고, 출처마다 '이 출처로 쓴 문장'을 적어 교사가 원문과 대조하기 쉽게 한다.
function finishSources(file) {
  const uses = new Map();
  const add = (id, text) => { if (!uses.has(id)) uses.set(id, []); uses.get(id).push(text); };
  file.EVENT.background.forEach((c) => add(c[1], c[0]));
  file.PERSONAS.forEach((p) => p.claims.forEach((c) => add(c[1], c[0])));
  file.MATERIALS.forEach((m) => { m.items.forEach((it) => it.src.forEach((id) => add(id, it.text))); (m.statsSrc || []).forEach((id) => add(id, `숫자 카드: ${(m.stats || []).map((s) => `${s.label} ${s.value}`).join(", ")}`)); });
  file.POLICY_CASES.forEach((c) => c.src.forEach((id) => add(id, `${c.country} 사례: ${c.title}`)));
  file.AFTERMATH.forEach((a) => a.src.forEach((id) => add(id, a.text)));
  for (const id of Object.keys(file.SOURCES)) {
    const u = [...new Set(uses.get(id) || [])];
    if (!u.length) { delete file.SOURCES[id]; continue; }
    file.SOURCES[id].check = `원문에서 확인할 것: ${u.slice(0, 4).map((t, i) => `${"①②③④"[i]} ${t.slice(0, 90)}`).join(" ")}${u.length > 4 ? ` 외 ${u.length - 4}곳` : ""}`;
  }
}

// 점검 단계: 인물마다 AI 점검 → 고친 문장 적용 → 자료 점검 → 입장 균형 의견 → 출처 정리 → 구조 검사.
async function review({ file, plan, research, only }, ai, { concurrency = 3 } = {}) {
  let calls = 0;
  const targets = file.PERSONAS.filter((p) => !only || only.includes(p.id));
  const fixes = [];
  await pool(targets, concurrency, async (p) => {
    try {
      const out = await ai.json({ messages: personaReviewMessages({ file, p, plan }), maxTokens: 4000, effort: "low" });
      fixes.push(...applyPersonaFixes(p, out.issues));
    } catch { /* 점검 실패는 건너뛰고 구조 검사로 넘어간다 */ }
    calls++;
  });
  let materialFixes = [], balance = null;
  if (!only) {
    const [mr, br] = await Promise.allSettled([
      ai.json({ messages: materialsReviewMessages({ file, research }), maxTokens: 5000, effort: "low" }),
      ai.json({ messages: balanceMessages({ file, plan }), maxTokens: 1200, effort: "low" }),
    ]);
    calls += 2;
    if (mr.status === "fulfilled") materialFixes = applyMaterialFixes(file, mr.value.issues);
    if (br.status === "fulfilled") balance = { ok: br.value.ok !== false, notes: arr(br.value.notes).slice(0, 5).map((x) => clip(x, 300)) };
  }
  finishSources(file);
  const check = checkBundle(file, { links: plan.links });
  return { fixes, materialFixes, balance, check, calls };
}

module.exports = {
  frame, frameMessages, planProblems, toFrame, persona, personaMessages, toPersona, personaProblems,
  extras, toExtras, review, numberFlags, applyPersonaFixes, applyMaterialFixes, finishSources, EX_EVENT, EX_PERSONA,
};
