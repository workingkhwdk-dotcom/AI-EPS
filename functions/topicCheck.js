// 주제 구조 검사: 기본 주제(cases/*.js)와 교사가 만든 주제에 같은 기준을 쓴다.
//  - errors: 고치기 전에는 수업에 쓸 수 없는 문제(빠진 칸, 없는 출처, 인물 수·축 부족, 실존 인물 이름 등)
//  - warnings: 쓸 수는 있지만 기본 주제보다 덜 다듬어진 곳(근거 진술이 적다, 이후 전개가 없다 등). 교사 검토 화면에 보인다.
// 기본 주제 열 개(원문 대조를 마친 다섯 개와 아직 대조하지 못한 새 다섯 개)는 errors 가 하나도 없어야 한다(test/topicCheck.test.js). 기준은 test/case.test.js 와 같다.

const KINDS = ["증언", "사실", "주장", "의견"];
// 인물의 목소리(편지·이야기·생각)에 나오면 안 되는 수업·개발 관점의 말
const META = /수업용|챗봇|AI|자료|보도|인터뷰/;
const AGE = /(\d+세|\d+대|스물|서른|마흔|쉰|예순|일흔|여든|[가-힣]{1,3}\s*살)/;
const FAMILY = /(부모|아버지|어머니|엄마|아빠|아내|남편|아이|딸|아들|동생|가족|형|누나|언니|오빠|손주|손자|손녀|할머니|할아버지|부부|혼자 산|혼자 살)/;
// 학생 화면의 예시 문구. 없으면 학생 화면이 사건과 무관한 기본 문구를 쓴다.
const UI_KEYS = ["letterSign", "causeExample", "badQuestion", "goodQuestion", "checkQuestion", "heardExample", "broadProblem", "decidedProblem",
  "pickLead", "requiredWho", "requiredTag", "casesKinds", "compareWith", "afterSince", "afterExample", "priorQuestion", "priorHint"];

const txt = (v) => (typeof v === "string" ? v.trim() : "");
const arr = (v) => (Array.isArray(v) ? v : []);

// file: { SOURCES, EVENT, PERSONAS, MATERIALS, POLICY_CASES, AFTERMATH, BRIEFS }
//  opts.links: [{ a, b, a_mark, b_mark }] 인물끼리 스치는 장면(구성안). 양쪽 이야기에 표시 말이 있는지 본다.
function checkBundle(file, { links = [] } = {}) {
  const errors = [], warnings = [];
  const err = (where, msg) => errors.push({ where, msg });
  const warn = (where, msg) => warnings.push({ where, msg });
  const S = file.SOURCES || {}, ev = file.EVENT || {}, ps = arr(file.PERSONAS);
  const srcOk = (where, ids) => {
    if (!arr(ids).length) return err(where, "출처가 없습니다.");
    for (const id of ids) if (!S[id]) err(where, `없는 출처 ${id}`);
  };

  // ---- 출처 ----
  for (const [id, s] of Object.entries(S)) {
    if (!/^https?:\/\//.test(txt(s.url))) err(`출처 ${id}`, "원문 주소(http/https)가 없습니다.");
    else if (!/^https:\/\//.test(s.url)) warn(`출처 ${id}`, "https 가 아닌 주소입니다.");
    if (!txt(s.title)) err(`출처 ${id}`, "제목이 없습니다.");
    if (!txt(s.outlet)) err(`출처 ${id}`, "매체 이름이 없습니다.");
    if (!txt(s.date)) warn(`출처 ${id}`, "날짜가 없습니다.");
  }

  // ---- 사건 ----
  for (const k of ["id", "title", "summary", "teacherNote", "now", "backgroundIntro"]) if (!txt(ev[k])) err("사건", `${k} 가 없습니다.`);
  if (txt(ev.summary) && ev.summary.length < 120) warn("사건", "사건 개요가 짧습니다.");
  const axes = arr(ev.axes);
  if (axes.length !== 4 || new Set(axes).size !== 4) err("사건", "인물의 처지(축)는 서로 다른 4개여야 합니다.");
  if (!axes.includes(ev.requiredAxis)) err("사건", "꼭 있어야 하는 축(requiredAxis)이 축 목록에 없습니다.");
  if (!arr(ev.personalAxes).length || !arr(ev.personalAxes).every((a) => axes.includes(a))) err("사건", "개인으로 등장하는 축(personalAxes)이 올바르지 않습니다.");
  if (arr(ev.stakeholders).length < 3) err("사건", "이해관계자(stakeholders)가 3개보다 적습니다.");
  const bg = arr(ev.background);
  if (bg.length < 5) err("사건 공통 배경", "5개 이상이어야 합니다.");
  bg.forEach((c, i) => {
    if (!Array.isArray(c) || txt(c[0]).length <= 10) err(`사건 공통 배경 ${i + 1}`, "내용이 없습니다.");
    else { srcOk(`사건 공통 배경 ${i + 1}`, [c[1]]); if (!KINDS.includes(c[2])) err(`사건 공통 배경 ${i + 1}`, `잘못된 종류 ${c[2]}`); }
  });
  const sc = ev.scope || {};
  for (const k of ["event", "time", "place"]) if (!txt(sc[k])) err("사건 범위", `${k} 가 없습니다.`);
  if (arr(sc.allowedTopics).length < 3) err("사건 범위", "허용 주제가 3개보다 적습니다.");
  if (arr(sc.outOfScope).length < 2) err("사건 범위", "범위 밖이 2개보다 적습니다.");
  if (!txt(ev.search?.scope) || !txt(ev.search?.example)) err("사건", "검색 범위(search.scope·example)가 없습니다.");
  for (const k of UI_KEYS) if (!txt(ev.ui?.[k])) err("화면 문구", `${k} 가 없습니다.`);
  if (arr(ev.ui?.sceneHints).length !== 3) err("화면 문구", "sceneHints 는 3개여야 합니다.");
  if (ev.ui?.requiredTag && ev.requiredAxis && ev.ui.requiredTag !== ev.requiredAxis) warn("화면 문구", "requiredTag 가 꼭 있어야 하는 축과 다릅니다.");

  // ---- 인물 ----
  if (ps.length < 6) err("인물", `인물이 ${ps.length}명입니다. 6명 이상이어야 합니다.`);
  else if (ps.length !== 9) warn("인물", `인물이 ${ps.length}명입니다(기본 주제는 9명).`);
  if (new Set(ps.map((p) => p.id)).size !== ps.length) err("인물", "인물 ID 가 겹칩니다.");
  if (new Set(ps.map((p) => p.name)).size !== ps.length) err("인물", "인물 이름이 겹칩니다.");
  for (const a of axes) {
    const n = ps.filter((p) => p.axis === a).length;
    if (!n) err("인물", `'${a}' 축의 인물이 없습니다.`);
    else if (n < 2) warn("인물", `'${a}' 축의 인물이 1명입니다(기본 주제는 축마다 2명 이상).`);
  }
  const realNames = arr(ev.realNames).map(txt).filter((x) => x.length >= 2);
  const personal = (p) => arr(ev.personalAxes).includes(p.axis);
  for (const p of ps) {
    const w = `인물 ${p.name || p.id}`;
    if (!txt(p.id)) err(w, "ID 가 없습니다.");
    if (!axes.includes(p.axis)) err(w, `축 '${p.axis}' 이 사건의 축 목록에 없습니다.`);
    if (!txt(p.name) || p.name.length > 8) err(w, "사람 이름이 없거나 너무 깁니다.");
    else if (p.name.length > 4) warn(w, "이름이 깁니다(4자 이하 권장).");
    if (!txt(p.label) || p.label === p.name) err(w, "교사용 역할명(label)이 없습니다.");
    for (const k of ["role", "stance"]) if (!txt(p[k])) err(w, `${k} 가 없습니다.`);
    if (txt(p.voice).length <= 10) err(w, "말투(voice)가 없습니다.");
    if (txt(p.setting).length <= 10) err(w, "설정(setting)이 없습니다.");
    const letter = arr(p.letter);
    if (letter.length < 5 || letter.join("").length < 350) err(w, "편지가 너무 짧습니다(5문단 이상).");
    else if (letter.length < 7 || letter.join("").length < 500) warn(w, "편지가 기본 주제보다 짧습니다(7문단·500자 이상 권장).");
    if (letter[0] && txt(p.name) && !letter[0].includes(p.name)) err(w, "편지 첫머리에 이름이 없습니다.");
    if (arr(p.views).length < 3) err(w, "인물의 생각(views)이 3개보다 적습니다.");
    if (arr(p.story).length < 4) err(w, "삶의 이야기(story)가 너무 적습니다.");
    else if (arr(p.story).length < 6) warn(w, "삶의 이야기가 6개보다 적습니다.");
    if (arr(p.episodes).length < 3) err(w, "기억나는 장면(episodes)이 너무 적습니다.");
    else if (arr(p.episodes).length < 4) warn(w, "기억나는 장면이 4개보다 적습니다.");
    if (txt(p.inner).length <= 20) err(w, "마음속 고민(inner)이 없습니다.");
    if (txt(p.habits).length <= 10) err(w, "말버릇(habits)이 없습니다.");
    if (txt(p.basis).length <= 10) err(w, "융합 근거(basis)가 없습니다.");
    const claims = arr(p.claims);
    if (claims.length < 4) err(w, `근거 진술이 ${claims.length}개입니다. 4개 이상이어야 합니다.`);
    else if (claims.length < 6) warn(w, `근거 진술이 ${claims.length}개입니다(기본 주제는 6개 이상).`);
    claims.forEach((c, i) => {
      if (!Array.isArray(c) || txt(c[0]).length <= 10) return err(`${w} 근거 진술 ${i + 1}`, "내용이 없습니다.");
      srcOk(`${w} 근거 진술 ${i + 1}`, [c[1]]);
      if (!KINDS.includes(c[2])) err(`${w} 근거 진술 ${i + 1}`, `잘못된 종류 ${c[2]}`);
    });
    const voiceText = [...letter, ...arr(p.views), ...arr(p.story), ...arr(p.episodes), txt(p.inner), txt(p.habits)].join(" ");
    const meta = voiceText.match(META);
    if (meta) err(w, `인물의 말에 수업·개발 관점의 말('${meta[0]}')이 있습니다.`);
    for (const n of realNames) if (voiceText.includes(n) || claims.some((c) => txt(c[0]).includes(n))) err(w, `실존 인물 이름 '${n}' 이 나옵니다. 직함으로만 부르세요.`);
    if (personal(p)) {
      const life = [txt(p.setting), ...arr(p.story)].join(" ");
      if (!AGE.test(life)) warn(w, "개인 인물인데 설정·이야기에 나이가 없습니다(신상 질문에 답할 수 없음).");
      if (!FAMILY.test(life)) warn(w, "개인 인물인데 설정·이야기에 가족이 없습니다.");
    }
    for (const [i, b] of arr(p.beliefs).entries()) if (!Array.isArray(b) || txt(b[0]).length <= 15 || txt(b[1]).length <= 15) err(`${w} 믿음 ${i + 1}`, "믿음과 실제 메모가 모두 있어야 합니다.");
    if (!txt(file.BRIEFS?.[p.id])) err(w, "학생에게 보이는 한 줄 소개(brief)가 없습니다.");
  }
  if (ps.filter((p) => arr(p.beliefs).length).length < Math.min(4, ps.length)) warn("인물", "틀릴 수 있는 믿음(beliefs)을 가진 인물이 4명보다 적습니다.");
  const life = (id) => { const p = ps.find((x) => x.id === id); return p ? [...arr(p.story), ...arr(p.episodes)].join(" ") : ""; };
  for (const l of links) {
    if (l.a_mark && !life(l.a).includes(l.a_mark)) warn("인물 연결", `${l.a} 의 이야기에 '${l.a_mark}' 장면이 없습니다.`);
    if (l.b_mark && !life(l.b).includes(l.b_mark)) warn("인물 연결", `${l.b} 의 이야기에 '${l.b_mark}' 장면이 없습니다.`);
  }

  // ---- 2단계 자료·사례·이후 전개 ----
  const mats = arr(file.MATERIALS);
  if (mats.length < 3) err("2단계 자료", "분류가 3개보다 적습니다.");
  else if (mats.length < 5) warn("2단계 자료", `분류가 ${mats.length}개입니다(기본 주제는 5개 이상).`);
  for (const c of mats) {
    const w = `2단계 자료 '${c.title || c.id}'`;
    if (!txt(c.id) || !txt(c.title)) err(w, "분류 ID·이름이 없습니다.");
    if (!arr(c.items).length && !arr(c.stats).length) err(w, "자료가 없습니다.");
    arr(c.items).forEach((it, i) => {
      if (!KINDS.includes(it.kind)) err(`${w} ${i + 1}`, `잘못된 종류 ${it.kind}`);
      if (txt(it.text).length <= 10) err(`${w} ${i + 1}`, "내용이 없습니다.");
      srcOk(`${w} ${i + 1}`, it.src);
    });
    if (arr(c.stats).length) srcOk(`${w} 숫자`, c.statsSrc);
  }
  const cases = arr(file.POLICY_CASES);
  if (cases.length < 3) warn("4단계 사례", `사례 카드가 ${cases.length}개입니다(기본 주제는 3개 이상).`);
  for (const c of cases) {
    const w = `4단계 사례 '${c.title || c.id}'`;
    if (!txt(c.country) || !txt(c.title)) err(w, "지역·제목이 없습니다.");
    if (txt(c.what).length <= 30 || txt(c.result).length <= 30 || txt(c.think).length <= 20) err(w, "무엇을 했나·어떻게 되었나·생각해 볼 점이 짧습니다.");
    srcOk(w, c.src);
  }
  const after = arr(file.AFTERMATH);
  if (after.length < 4) warn("7단계 이후 전개", `이후 전개가 ${after.length}개입니다(기본 주제는 4개 이상). 진행 중인 사건이면 없을 수 있습니다.`);
  after.forEach((a, i) => {
    if (!KINDS.includes(a.kind)) err(`7단계 이후 전개 ${i + 1}`, `잘못된 종류 ${a.kind}`);
    if (txt(a.text).length <= 10) err(`7단계 이후 전개 ${i + 1}`, "내용이 없습니다.");
    srcOk(`7단계 이후 전개 ${i + 1}`, a.src);
  });

  // 쓰이지 않는 출처
  const used = new Set([
    ...ps.flatMap((p) => arr(p.claims).map((c) => c[1])), ...bg.map((c) => c[1]),
    ...mats.flatMap((m) => [...arr(m.statsSrc), ...arr(m.items).flatMap((i) => arr(i.src))]),
    ...cases.flatMap((c) => arr(c.src)), ...after.flatMap((a) => arr(a.src)),
  ]);
  for (const id of Object.keys(S)) if (!used.has(id)) warn(`출처 ${id}`, "어디에도 쓰이지 않는 출처입니다.");

  return { errors, warnings, ok: errors.length === 0 };
}

module.exports = { checkBundle, KINDS, META, UI_KEYS };
