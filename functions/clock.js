// 단계 시간(수업 시계). 교사가 반 전체의 단계와 남은 시간을 정하고, 학생 화면은 sessions/{code}.clock 을 읽어 보여 준다.
//  - 기본 시간은 본시 수업지도안(50분 × 3차시)의 배분을 따른다.
//      1차시: 1단계 35′(수업 열기 5′는 '수업 시작하기' 전 대기실에서 하므로 단계 시간은 30′), 2단계 앞부분 15′
//      2차시: 2단계 확인 질문 5′(→ 2단계 합계 20′, 차시 사이에는 '멈춤'), 3단계 20′, 4단계 25′
//      3차시: 5단계 20′, 6단계 10′, 7단계 20′
//  - 교사는 수업을 만들 때·수업 설정에서 단계마다 분(1~120)을 바꾸고(stageMin), 수업 중에 시간을 더하거나 멈추거나 다음 단계로 넘긴다.
//  - 시계 모양: { stage, min(이 단계에 처음 준 분), add(수업 중 더한 분), endsAt(끝나는 서버 시각 ms, 멈추면 null), left(멈춘 동안 남은 ms), ev(마지막 조작), t(조작한 서버 시각) }
//    끝나는 시각을 서버 시각으로 두므로 학생 화면은 기기 시계의 오차를 따로 맞춘다(public/clock.js).
// 학생 화면(public/clock.js)·교사 화면(public/teacher.js)에도 같은 기본값이 있다. 고칠 때 함께 고칠 것.

const STAGE_MIN_DEFAULT = { 1: 30, 2: 20, 3: 20, 4: 25, 5: 20, 6: 10, 7: 20 };
const STAGE_MIN_RANGE = [1, 120];
const ADD_MIN_RANGE = [1, 30];
const MIN = 60 * 1000;

// 수업에 저장된 단계별 분. 없거나 틀린 값은 기본값.
function stageMinOf(sess) {
  const s = sess?.stageMin || {};
  return Object.fromEntries(Object.entries(STAGE_MIN_DEFAULT).map(([k, v]) => {
    const n = Number(s[k]);
    return [k, Number.isInteger(n) && n >= STAGE_MIN_RANGE[0] && n <= STAGE_MIN_RANGE[1] ? n : v];
  }));
}
// 교사가 보낸 단계별 분: 1~7단계가 모두 1~120 사이의 정수여야 한다. 틀리면 null.
function sanitizeStageMin(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out = {};
  for (const k of Object.keys(STAGE_MIN_DEFAULT)) {
    const n = Number(d[k]);
    if (!Number.isInteger(n) || n < STAGE_MIN_RANGE[0] || n > STAGE_MIN_RANGE[1]) return null;
    out[k] = n;
  }
  return out;
}

// 남은 시간(ms). 시간이 지났으면 음수. 시계가 없으면 null.
function leftMs(clock, now) {
  if (!clock) return null;
  if (clock.endsAt == null) return clock.left ?? 0;
  return clock.endsAt - now;
}

// 교사의 조작을 시계에 적용한 새 시계를 돌려준다(시계를 끄면 null). 잘못된 조작이면 Error.
//  go     { stage }  : 그 단계를 처음부터(그 단계의 기본 분) 시작한다. 다음 단계로 넘기기·다른 단계로 옮기기에 쓴다.
//  add    { min }    : 시간을 더한다. 이미 시간이 지났으면 지금부터 센다.
//  pause / resume    : 멈추고 이어 간다(차시 사이, 잠깐 설명할 때).
//  stop              : 시계를 끈다(학생은 단계를 자유롭게 오간다).
function applyClock(clock, op, stageMin, now) {
  const o = op || {};
  switch (o.op) {
    case "go": {
      const stage = Number(o.stage);
      if (!Number.isInteger(stage) || stage < 1 || stage > 7) throw new Error("단계는 1~7 사이로 고르세요.");
      const min = stageMin[stage];
      return { stage, min, add: 0, endsAt: now + min * MIN, left: null, ev: "go", t: now };
    }
    case "add": {
      if (!clock) throw new Error("먼저 단계 시간을 시작하세요.");
      const m = Number(o.min);
      if (!Number.isInteger(m) || m < ADD_MIN_RANGE[0] || m > ADD_MIN_RANGE[1]) throw new Error(`더할 시간은 ${ADD_MIN_RANGE[0]}~${ADD_MIN_RANGE[1]}분 사이로 정하세요.`);
      const base = { ...clock, add: (clock.add || 0) + m, ev: "add", addNow: m, t: now };
      return clock.endsAt == null
        ? { ...base, left: Math.max(0, clock.left || 0) + m * MIN }
        : { ...base, endsAt: Math.max(clock.endsAt, now) + m * MIN };
    }
    case "pause":
      if (!clock) throw new Error("먼저 단계 시간을 시작하세요.");
      if (clock.endsAt == null) return clock;
      return { ...clock, endsAt: null, left: Math.max(0, clock.endsAt - now), ev: "pause", t: now };
    case "resume":
      if (!clock) throw new Error("먼저 단계 시간을 시작하세요.");
      if (clock.endsAt != null) return clock;
      return { ...clock, endsAt: now + Math.max(0, clock.left || 0), left: null, ev: "resume", t: now };
    case "stop":
      return null;
    default:
      throw new Error("알 수 없는 시간 조작입니다.");
  }
}

module.exports = { STAGE_MIN_DEFAULT, STAGE_MIN_RANGE, ADD_MIN_RANGE, stageMinOf, sanitizeStageMin, leftMs, applyClock };
