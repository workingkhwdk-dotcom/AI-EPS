// 수업 사건 모음. 사건마다 cases/<사건 ID>.js 에 출처(SOURCES)·사건(EVENT)·인물(PERSONAS)·실제 자료(MATERIALS)·
// 다른 나라 사례 카드(POLICY_CASES)·실제 이후 전개(AFTERMATH)·인물 한 줄 소개(BRIEFS)를 둔다.
//
// 설계 원칙
//  1) 페르소나는 실제 보도·보고서·인터뷰에서 확인된 진술(claims)에 근거한다. 핵심 사건 사실은 claims 안에서만 말하고,
//     claims 에 없는 사소한 일상·감정은 어긋나지 않는 범위에서 자연스럽게 지어낼 수 있다(prompts.js 의 규칙).
//     학생 화면에는 사람 이름(name)과 한 줄 소개만 보인다. 역할(label)·근거·출처는 교사에게만 보인다.
//  2) 같은 처지·같은 유형의 여러 인터뷰는 한 인물로 융합한다(composite). 융합 근거는 basis 에 적는다.
//  3) 진술 종류(kind): 증언(당사자가 말한 것) / 사실(공식 발표·보도된 사실) / 주장(집단의 주장, 사실 검증 필요) / 의견(개인·단체의 의견)
//  4) 출처는 원문과 대조해 사건 파일에 verified: true 를 적기 전에는 학생에게 노출되지 않는다
//     (ALLOW_UNVERIFIED_PERSONAS=true 인 리허설 제외).
//  5) 인물 위에는 상위 AI(사건 규범 감독자, charter.js)가 있어 사건 범위(EVENT.scope)와 근거 진술을 벗어난 응답을 차단한다.
//  6) 출처 ID 는 사건마다 다른 머리글자를 쓴다(제주 J·C·A·N, 쓰레기 수출 W·WC·WA, 특수학교 S·SC·SA, 주남저수지 JN·JNC·JNA, 창원 인구 P·PC·PA). 모든 사건의 출처를 한 목록으로 합쳐 쓰기 때문이다.
//
// 주의: 진술은 AI가 웹 검색 결과 요약을 바탕으로 정리했다. 대조 상태는 docs/PERSONA_SOURCES.md 에 있다.

const CASE_FILES = [require("./cases/jeju2018"), require("./cases/waste2019"), require("./cases/school2018"),
  require("./cases/junam2025"), require("./cases/changwon2025")];

// 출처 하나를 정리한다: 설명 제목 표시와 검증 여부는 참·거짓으로만 둔다(verified: true 를 적지 않은 출처는 미검증)
const normSource = (s) => ({ ...s, titleIsDescriptive: !!s.titleIsDescriptive, verified: s.verified === true });

const SOURCES = {};
for (const c of CASE_FILES) for (const [id, s] of Object.entries(c.SOURCES)) {
  if (SOURCES[id]) throw new Error(`출처 ID 중복: ${id}`);
  SOURCES[id] = s;
}
Object.values(SOURCES).forEach((s) => { s.titleIsDescriptive = !!s.titleIsDescriptive; });
// 교차 확인 기록(사건 파일의 CROSS_CHECK): ok / partial / fixed / todo 와 메모
for (const c of CASE_FILES) Object.entries(c.CROSS_CHECK || {}).forEach(([id, [status, note]]) => { if (SOURCES[id]) SOURCES[id].crossCheck = { status, note }; });
// 원문 대조를 마친 출처만 사건 파일에 verified: true 를 적는다. 적지 않은 출처는 미검증으로 본다.
Object.values(SOURCES).forEach((s) => (s.verified = s.verified === true));

// 주제 묶음(bundle): 사건 하나의 출처·사건·인물·자료·사례·이후 전개·한 줄 소개를 한데 모은 것.
// 기본 주제(cases/*.js)와 교사가 만든 주제(teacherTopics, 수업마다 사본)가 같은 모양이라 아래 함수를 함께 쓴다.
//  - custom: 교사가 만든 주제. 인물마다 개인 인물인지(_personal)·꼭 있어야 하는 인물인지(_required)를 미리 적어 둔다
//    (기본 주제는 사건 ID 로 찾아 알 수 있지만, 교사 주제는 수업 사본이라 전역 목록에 없다).
function makeBundle(file, { custom = false } = {}) {
  const ev = file.EVENT;
  const sources = custom
    ? Object.fromEntries(Object.entries(file.SOURCES || {}).map(([id, s]) => [id, normSource(s)]))
    : Object.fromEntries(Object.keys(file.SOURCES || {}).map((id) => [id, SOURCES[id]]));
  const personas = custom
    ? (file.PERSONAS || []).map((p) => ({ ...p, events: [ev.id], _personal: (ev.personalAxes || []).includes(p.axis), _required: p.axis === ev.requiredAxis }))
    : file.PERSONAS;
  return { custom, event: ev, sources, personas, materials: file.MATERIALS || [], cases: file.POLICY_CASES || [], aftermath: file.AFTERMATH || [], briefs: file.BRIEFS || {} };
}

const DEFAULT_EVENT = "jeju2018";
const BUNDLES = Object.fromEntries(CASE_FILES.map((c) => [c.EVENT.id, makeBundle(c)]));
// 사건 ID 나 묶음을 받아 묶음을 돌려준다(모르는 사건 ID 는 기본 사건)
const B = (x) => (x && typeof x === "object" ? x : BUNDLES[x] || BUNDLES[DEFAULT_EVENT]);

const EVENTS = Object.fromEntries(CASE_FILES.map((c) => [c.EVENT.id, c.EVENT]));
const PERSONAS = CASE_FILES.flatMap((c) => c.PERSONAS);
// 실제 사건 자료: 사건별로 학생에게 카테고리별로 보여 줄 객관적 정리. 항목마다 종류(사실·증언·주장·의견)와 출처 ID.
// 출처가 모두 검증된 항목만 학생에게 나간다. 학생에게는 출처 ID 대신 매체·날짜 캡션만 보인다.
const MATERIALS = Object.fromEntries(CASE_FILES.map((c) => [c.EVENT.id, c.MATERIALS]));
// 4단계 다른 나라(다른 곳) 사례 카드와 7단계 실제 이후 전개(사건별)
const CASES = Object.fromEntries(CASE_FILES.map((c) => [c.EVENT.id, c.POLICY_CASES || []]));
const AFTERMATH = Object.fromEntries(CASE_FILES.map((c) => [c.EVENT.id, c.AFTERMATH || []]));
// 학생이 인물을 고를 때 보는 한 줄 소개(편지와 함께). 하는 일만 적고 입장·평가는 담지 않는다. 인물 ID 는 사건 사이에서도 겹치지 않는다.
const BRIEFS = Object.assign({}, ...CASE_FILES.map((c) => c.BRIEFS || {}));

const fmtDate = (d) => { const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(d); return m ? `${m[1]}.${+m[2]}${m[3] ? "." + +m[3] : ""}` : ""; };
// 교사 주제는 자기 출처만 본다(없는 ID 가 기본 주제의 같은 ID 출처로 잘못 이어지지 않게)
const srcOf = (b, id) => (b.custom ? b.sources[id] : b.sources[id] || SOURCES[id]);
const captionIn = (b, src) => [...new Set(src.map((id) => { const x = srcOf(b, id); return x ? `${x.outlet.replace(/\(.*\)/, "").trim()} ${fmtDate(x.date)}`.trim() : ""; }).filter(Boolean))].slice(0, 2).join(" · ");
const verifiedIn = (b, src) => src.every((id) => srcOf(b, id)?.verified === true);

// 학생용: 검증된 항목만, 출처 ID 없이 매체·날짜 캡션만
function materialsFor(eventId, allowUnverified = false) {
  const b = B(eventId);
  return b.materials.map((c) => ({
    id: c.id, title: c.title, type: c.type || "list",
    stats: c.stats && (allowUnverified || verifiedIn(b, c.statsSrc || [])) ? c.stats : undefined,
    items: c.items.filter((it) => allowUnverified || verifiedIn(b, it.src))
      .map((it) => ({ date: it.date, kind: it.kind, text: it.text, caption: captionIn(b, it.src) })),
  })).filter((c) => c.items.length || c.stats);
}
// 교사용: 출처 ID 포함 전체
const materialsAdmin = (eventId) => { const b = B(eventId); return b.materials.map((c) => ({ ...c, items: c.items.map((it) => ({ ...it, caption: captionIn(b, it.src) })) })); };

// 학생용 출처 표시: 매체·날짜·링크
const linkIn = (b, id) => { const x = srcOf(b, id) || {}; return { title: x.title || "", outlet: x.outlet || "", date: x.date || "", url: x.url || "" }; };
// 학생용 사례 카드(검증된 것만) / 교사용 전체
const casesFor = (eventId, allowUnverified = false) => { const b = B(eventId); return b.cases.filter((c) => allowUnverified || verifiedIn(b, c.src))
  .map(({ src, ...c }) => ({ ...c, links: src.map((id) => linkIn(b, id)) })); };
const casesAdmin = (eventId) => { const b = B(eventId); return b.cases.map((c) => ({ ...c, verified: verifiedIn(b, c.src), links: c.src.map((id) => linkIn(b, id)) })); };
const aftermathFor = (eventId, allowUnverified = false) => { const b = B(eventId); return b.aftermath.filter((it) => allowUnverified || verifiedIn(b, it.src))
  .map((it) => ({ kind: it.kind, text: it.text, caption: captionIn(b, it.src), links: it.src.map((id) => linkIn(b, id)) })); };
const aftermathAdmin = (eventId) => { const b = B(eventId); return b.aftermath.map((it) => ({ ...it, caption: captionIn(b, it.src), verified: verifiedIn(b, it.src) })); };

function toPublicSource(id, bundle) {
  const s = (bundle ? srcOf(B(bundle), id) : SOURCES[id]) || { title: "(없는 출처)", outlet: "", date: "", url: "", verified: false, check: "" };
  return { id, title: s.title, titleIsDescriptive: !!s.titleIsDescriptive, outlet: s.outlet, date: s.date, url: s.url, verified: s.verified === true, check: s.check, crossCheck: s.crossCheck || null };
}

const personaSourceIds = (p) => [...new Set(p.claims.map((c) => c[1]))];
const backgroundSourceIds = (ev) => [...new Set((ev.background || []).map((c) => c[1]))];
// 인물의 진술 출처와, 그 인물이 쓰는 사건 공통 배경의 출처가 모두 검증되어야 학생에게 쓸 수 있다
function personaVerified(p, bundle) {
  const b = bundle ? B(bundle) : B(p.events[0]);
  return verifiedIn(b, [...personaSourceIds(p), ...backgroundSourceIds(b.event)]);
}

// 이 사건에서 학생에게 쓸 수 있는 페르소나 (출처 검증 완료분. 리허설 모드는 전부)
function availablePersonas(eventId, allowUnverified = false) {
  const b = B(eventId);
  return b.personas.filter((p) => p.events.includes(b.event.id) && (allowUnverified || personaVerified(p, b)));
}

// 모둠에 꼭 한 명은 있어야 하는 인물(사건마다 정한 축, 예: 제주는 난민 신청자). 직접 고르게 하면 아무도 안 고를 수 있어서 서버가 지킨다.
const eventOf = (p) => EVENTS[p?.events?.[0]];
const isRequired = (p) => !!p && (p._required !== undefined ? p._required === true : p.axis === eventOf(p)?.requiredAxis);

module.exports = { BRIEFS, DEFAULT_EVENT, isRequired, makeBundle, BUNDLES, normSource,
  SOURCES, EVENTS, PERSONAS, MATERIALS, CASES, AFTERMATH, availablePersonas, personaSourceIds, personaVerified, toPublicSource,
  materialsFor, materialsAdmin, casesFor, casesAdmin, aftermathFor, aftermathAdmin,
};
