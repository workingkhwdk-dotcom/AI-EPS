// 2단계 '실제 사건 자료'를 수업마다 고칠 수 있게 하는 도구.
//  - 기본값은 case.js 의 MATERIALS(출처 검증 완료분)이다. 교사가 고치기 전까지는 기본값을 그대로 쓴다.
//  - 교사가 추가·수정·삭제하면 수업 문서(sessions/{code}/private/materials)에 그 수업만의 목록으로 저장한다.
//  - 교사가 직접 넣은 자료는 출처 검증 대상이 아니며, 교사가 확인한 내용으로 학생에게 보인다.
const { materialsFor } = require("./case");

const KINDS = ["사실", "증언", "주장", "의견"];
const TYPES = ["list", "timeline"];
const LIMITS = { categories: 12, items: 60, title: 40, date: 24, text: 600, caption: 80, stats: 6, statLabel: 20, statValue: 20 };

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// 교사 화면에서 편집하기 쉬운 형태(항목마다 id)로 기본 자료를 만든다
function defaultMaterials(allowUnverified = false) {
  return materialsFor(allowUnverified).map((c) => ({
    id: c.id, title: c.title, type: TYPES.includes(c.type) ? c.type : "list",
    ...(c.stats ? { stats: c.stats } : {}),
    items: c.items.map((it, i) => ({ id: `${c.id}-${i + 1}`, date: it.date || "", kind: it.kind, text: it.text, caption: it.caption || "" })),
  }));
}

// 클라이언트가 보낸 목록을 검사하고 정리한다. 형식이 틀리면 Error(메시지)를 던진다.
function sanitizeMaterials(input) {
  if (!Array.isArray(input)) throw new Error("자료 목록 형식이 올바르지 않습니다.");
  if (input.length > LIMITS.categories) throw new Error(`분류는 최대 ${LIMITS.categories}개까지 만들 수 있습니다.`);
  const seen = new Set();
  const uniq = (id, prefix) => { let x = str(id, 60).replace(/[^\w\-가-힣]/g, "") || makeId(prefix); while (seen.has(x)) x = makeId(prefix); seen.add(x); return x; };
  return input.map((c) => {
    const title = str(c?.title, LIMITS.title);
    if (!title) throw new Error("분류 이름을 입력하세요.");
    const rawItems = Array.isArray(c.items) ? c.items : [];
    if (rawItems.length > LIMITS.items) throw new Error(`'${title}' 분류의 자료는 최대 ${LIMITS.items}개까지입니다.`);
    const items = rawItems.map((it) => {
      const text = str(it?.text, LIMITS.text);
      if (!text) throw new Error(`'${title}' 분류에 내용이 빈 자료가 있습니다.`);
      return { id: uniq(it.id, "m"), date: str(it.date, LIMITS.date), kind: KINDS.includes(it.kind) ? it.kind : "사실", text, caption: str(it.caption, LIMITS.caption) };
    });
    const stats = Array.isArray(c.stats)
      ? c.stats.slice(0, LIMITS.stats).map((s) => ({ label: str(s?.label, LIMITS.statLabel), value: str(s?.value, LIMITS.statValue) })).filter((s) => s.label && s.value)
      : [];
    return { id: uniq(c.id, "c"), title, type: TYPES.includes(c.type) ? c.type : "list", ...(stats.length ? { stats } : {}), items };
  });
}

// 학생에게 보낼 모양: 비어 있는 분류는 빼고, 출처 캡션이 없으면 교사 제공으로 표시
function toStudentMaterials(cats) {
  return (cats || []).map((c) => ({
    id: c.id, title: c.title, type: c.type || "list", stats: c.stats?.length ? c.stats : undefined,
    items: (c.items || []).map((it) => ({ date: it.date || undefined, kind: it.kind, text: it.text, caption: it.caption || "선생님이 준비한 자료" })),
  })).filter((c) => c.items.length || c.stats);
}

module.exports = { defaultMaterials, sanitizeMaterials, toStudentMaterials, KINDS, TYPES, LIMITS };
