// 교사가 수업마다 고칠 수 있는 인물 항목. 말투·삶의 이야기·의견·편지처럼 '사실 검증과 무관한' 항목만 허용한다.
// 사건의 사실(근거 진술, 출처, 인물 설정 setting, 입장 stance)은 원문 대조를 거친 코드(case.js)에서만 바뀐다.
const TEXT_FIELDS = { voice: 300, habits: 200, inner: 400 };
const LIST_FIELDS = { story: [12, 400], episodes: [12, 400], views: [10, 300], letter: [8, 600] };
const EDITABLE = [...Object.keys(TEXT_FIELDS), ...Object.keys(LIST_FIELDS)];

const clean = (v, max) => String(v ?? "").trim().slice(0, max);

// 보낸 값을 검사해 허용된 항목만 남긴다. 목록 항목은 빈 줄을 버린다. 편지·의견은 비울 수 없다.
function sanitizeOverride(fields) {
  const out = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) {
    if (fields?.[k] === undefined) continue;
    out[k] = clean(fields[k], max);
  }
  for (const [k, [n, max]] of Object.entries(LIST_FIELDS)) {
    if (fields?.[k] === undefined) continue;
    if (!Array.isArray(fields[k])) throw new Error("목록 형식이 올바르지 않습니다.");
    if (fields[k].length > n) throw new Error(`'${k}'는 최대 ${n}개까지 쓸 수 있습니다.`);
    out[k] = fields[k].map((x) => clean(x, max)).filter(Boolean);
    if ((k === "letter" || k === "views") && !out[k].length) throw new Error(k === "letter" ? "편지는 비울 수 없습니다." : "인물의 생각은 하나 이상 있어야 합니다.");
  }
  if (!Object.keys(out).length) throw new Error("고칠 항목이 없습니다.");
  return out;
}

const applyOverride = (persona, ov) => (ov ? { ...persona, ...Object.fromEntries(Object.entries(ov).filter(([k]) => EDITABLE.includes(k))) } : persona);

module.exports = { sanitizeOverride, applyOverride, EDITABLE, TEXT_FIELDS, LIST_FIELDS };
