// GYR 프로토콜을 서버에서 강제하는 규칙 엔진 (외부 의존성 없음, 단위 테스트 대상)
//  - AI 미사용 단계(6, 7)는 호출 자체를 차단. 2단계는 '생각 도우미'(답을 주지 않고 질문 하나만 던지는 AI)만 허용
//  - 1단계는 사전 질문 없이 바로 대화한다(대화하며 질문이 바뀔 수 있다). 학생이 먼저 말을 건다는 것이 선행 사고다.
//  - 3~5단계는 학습자의 선행 사고(work 에 저장된 입력)가 있어야 호출 허용(3단계: 실제 자료에서 먼저 찾아본 결과)
//  - 단계 순서도 확인한다: 3단계는 1단계 ③ 모둠 문제, 4단계는 3단계 ③ 가장 큰 원인, 5단계는 4단계 ② 최종 해결책이 있어야 열린다

const STAGE_RULES = {
  1: { ai: true, type: "persona_chat" },
  2: { ai: true, type: "coach" },
  3: { ai: true, type: "verify_query" },
  4: { ai: true, type: "proposal_feedback" },
  5: { ai: true, type: "scenario" },
  6: { ai: false },
  7: { ai: false },
};

const MAX_MESSAGE_LEN = 500;
const MIN_QUESTION_LEN = 5;
const MIN_PROPOSAL_LEN = 30;
const MIN_PREDICTIONS = 2;
const MIN_PREDICTION_LEN = 10;
const MIN_PROBLEM_LEN = 10;
const MIN_CAUSE_LEN = 10;
const ROUNDS = [1, 3, 5];
const FINAL_ID = "final";
const COACH_FOCUS = ["link", "cause"];
const MIN_LINK_LEN = 8; // 5단계에서 4단계 최종 해결책을 가리키는 ID

const blocked = (reason) => ({ ok: false, reason });
const allowed = () => ({ ok: true });
const str = (v) => (typeof v === "string" ? v.trim() : "");

// 모둠 산출물의 목록은 {항목ID: 항목} 지도로 저장된다(동시에 추가해도 서로 덮어쓰지 않도록). 배열도 받아 준다.
function toList(x) {
  if (Array.isArray(x)) return x.map((v, i) => (v && typeof v === "object" ? { id: String(v.id ?? i), ...v } : { id: String(i), text: v }));
  return Object.entries(x || {})
    .map(([id, v]) => ({ id, ...(v && typeof v === "object" ? v : { text: v }) }))
    .sort((a, b) => (a.t || 0) - (b.t || 0));
}

// 5단계 시뮬레이션 대상: 4단계 최종 해결책("final") 또는 후보 해결책
function proposalText(work, id) {
  if (id === "final") { const f = str(work.s4?.final); return f.length >= MIN_PROPOSAL_LEN ? f : ""; }
  return str(toList(work.s4?.proposals).find((x) => x.id === id)?.text);
}

// 앞 단계에서 모둠이 정한 것(단계 순서 확인용)
const groupProblem = (work) => str(work.s1?.problem?.hmw);
const coreCause = (work) => str(work.s3?.chain?.cause);
const finalProposal = (work) => str(work.s4?.final);

function checkGate({ stage, type, work = {}, payload = {} }) {
  const rule = STAGE_RULES[stage];
  if (!rule) return blocked("존재하지 않는 단계입니다.");
  if (!rule.ai) return blocked(`${stage}단계는 우리가 직접 생각하는 단계라 AI를 쓸 수 없어요.`);
  if (rule.type !== type) return blocked("이 단계에서는 쓸 수 없는 AI 기능이에요.");

  switch (stage) {
    case 1: {
      const msg = str(payload.message);
      if (!msg) return blocked("메시지를 입력하세요.");
      if (msg.length > MAX_MESSAGE_LEN) return blocked(`메시지는 ${MAX_MESSAGE_LEN}자 이하로 쓰세요.`);
      return allowed();
    }
    case 2: {
      // 생각 도우미: 학생이 먼저 쓴 것(연결 또는 원인 추측)을 보고 질문만 한다
      if (!COACH_FOCUS.includes(payload.focus)) return blocked("생각 도우미에게 보여 줄 것을 고르세요.");
      if (payload.focus === "link") {
        const l = toList(work.s2?.links).find((x) => x.id === payload.linkId);
        if (!l) return blocked("먼저 내 생각을 적고 저장해야 생각 도우미에게 보여 줄 수 있어요.");
        if ((str(l.source) + str(l.scene)).length < MIN_LINK_LEN) return blocked("'그 생각은 어디서 왔을까'나 '내 생활의 장면'을 조금 더 써 주세요.");
        return allowed();
      }
      if (groupProblem(work).length < MIN_PROBLEM_LEN) return blocked("1단계 ③에서 모둠이 풀 문제(질문)를 먼저 정하세요.");
      if (toList(work.s2?.causes).filter((x) => str(x.text).length >= 4).length < 2) return blocked("원인을 두 개 이상 먼저 써야 생각 도우미에게 보여 줄 수 있어요.");
      return allowed();
    }
    case 3: {
      if (groupProblem(work).length < MIN_PROBLEM_LEN) return blocked("1단계 ③에서 모둠이 풀 문제(질문)를 먼저 정하세요.");
      const c = toList(work.s2?.checks).find((x) => x.id === payload.checkId);
      if (!c) return blocked("2단계에서 만든 확인 질문만 AI에게 물을 수 있습니다.");
      if (str(c.question).length < MIN_QUESTION_LEN) return blocked("확인 질문을 더 구체적으로 써 주세요.");
      // 선행 사고: 실제 자료에서 먼저 찾아본 결과(없으면 '자료에 없음')를 적어야 AI에게 묻는다
      if (str(c.real).length < 2) return blocked("2단계 확인 질문 카드의 '위 자료와 비교하면?'에서 실제 사건 자료와 비교한 결과를 먼저 골라 주세요. 자료에서 못 찾았다면 '자료에 없다'를 고르세요.");
      return allowed();
    }
    case 4: {
      if (coreCause(work).length < MIN_CAUSE_LEN) return blocked("3단계 ③에서 가장 큰 원인을 먼저 정하세요.");
      const p = toList(work.s4?.proposals).find((x) => x.id === payload.proposalId);
      if (!p || str(p.text).length < MIN_PROPOSAL_LEN)
        return blocked(`모둠 해결책을 ${MIN_PROPOSAL_LEN}자 이상 먼저 써 주세요.`);
      return allowed();
    }
    case 5: {
      if (finalProposal(work).length < MIN_PROPOSAL_LEN) return blocked(`4단계 ②에서 최종 해결책을 ${MIN_PROPOSAL_LEN}자 이상 먼저 쓰세요.`);
      const preds = toList(work.s5?.predictions).filter((x) => str(x.text).length >= MIN_PREDICTION_LEN);
      if (preds.length < MIN_PREDICTIONS)
        return blocked(`사람들이 어떻게 반응할지 ${MIN_PREDICTIONS}개 이상 먼저 써 주세요.`);
      if (!proposalText(work, payload.proposalId)) return blocked("미래를 그려 볼 해결책을 선택하세요. (최종 해결책은 30자 이상)");
      if (!ROUNDS.includes(payload.round)) return blocked("몇 년 뒤의 미래를 볼지(1년, 3년, 5년 후) 골라 주세요.");
      return allowed();
    }
    default:
      return blocked("알 수 없는 단계입니다.");
  }
}

module.exports = { STAGE_RULES, COACH_FOCUS, ROUNDS, MAX_MESSAGE_LEN, MIN_PROBLEM_LEN, MIN_CAUSE_LEN, checkGate, toList, proposalText };
