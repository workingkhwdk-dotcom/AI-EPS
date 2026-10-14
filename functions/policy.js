// GYR 프로토콜을 서버에서 강제하는 규칙 엔진 (외부 의존성 없음, 단위 테스트 대상)
//  - AI 미사용 단계(2, 6, 7)는 호출 자체를 차단
//  - Yellow 단계(1, 3, 4, 5)는 학습자의 선행 사고(work에 저장된 입력)가 있어야 호출 허용

const STAGE_RULES = {
  1: { ai: true, type: "persona_chat" },
  2: { ai: false },
  3: { ai: true, type: "verify_query" },
  4: { ai: true, type: "proposal_feedback" },
  5: { ai: true, type: "scenario" },
  6: { ai: false },
  7: { ai: false },
};

const MAX_MESSAGE_LEN = 500;
const MIN_PRE_QUESTIONS = 3;
const MIN_PROPOSAL_LEN = 30;
const MIN_PREDICTIONS = 2;
const MIN_PREDICTION_LEN = 10;
const ROUNDS = [1, 3, 5];

const blocked = (reason) => ({ ok: false, reason });
const allowed = () => ({ ok: true });
const str = (v) => (typeof v === "string" ? v.trim() : "");

function checkGate({ stage, type, work = {}, payload = {}, personaIds = [] }) {
  const rule = STAGE_RULES[stage];
  if (!rule) return blocked("존재하지 않는 단계입니다.");
  if (!rule.ai) return blocked(`${stage}단계는 학습자 스스로 사고하는 단계라 AI를 사용할 수 없습니다.`);
  if (rule.type !== type) return blocked("이 단계에서 허용되지 않는 AI 기능입니다.");

  switch (stage) {
    case 1: {
      const qs = (work.s1?.preQuestions || []).map(str).filter((q) => q.length >= 5);
      if (qs.length < MIN_PRE_QUESTIONS)
        return blocked(`먼저 모둠에서 사전 질문을 ${MIN_PRE_QUESTIONS}개 이상 만들어 저장하세요.`);
      if (!personaIds.includes(payload.personaId)) return blocked("대화할 인물을 선택하세요.");
      const msg = str(payload.message);
      if (!msg) return blocked("질문을 입력하세요.");
      if (msg.length > MAX_MESSAGE_LEN) return blocked(`질문은 ${MAX_MESSAGE_LEN}자 이하로 쓰세요.`);
      return allowed();
    }
    case 3: {
      const list = (work.s2?.verifyQuestions || []).map(str).filter(Boolean);
      const q = str(payload.question);
      if (!list.length) return blocked("2단계에서 검증 질문 목록을 먼저 만드세요.");
      if (!list.includes(q)) return blocked("2단계에서 만든 검증 질문만 AI에게 물을 수 있습니다.");
      return allowed();
    }
    case 4: {
      const p = (work.s4?.proposals || []).find((x) => x.id === payload.proposalId);
      if (!p || str(p.text).length < MIN_PROPOSAL_LEN)
        return blocked(`모둠 대안을 ${MIN_PROPOSAL_LEN}자 이상 먼저 작성해 저장하세요.`);
      return allowed();
    }
    case 5: {
      const preds = (work.s5?.predictions || []).filter((x) => str(x.text).length >= MIN_PREDICTION_LEN);
      if (preds.length < MIN_PREDICTIONS)
        return blocked(`이해관계자 반응 예측을 ${MIN_PREDICTIONS}개 이상 먼저 작성해 저장하세요.`);
      const p = (work.s4?.proposals || []).find((x) => x.id === payload.proposalId);
      if (!p) return blocked("시뮬레이션할 대안을 선택하세요.");
      if (!ROUNDS.includes(payload.round)) return blocked("시점(1년, 3년, 5년 후)을 선택하세요.");
      return allowed();
    }
    default:
      return blocked("알 수 없는 단계입니다.");
  }
}

module.exports = { STAGE_RULES, ROUNDS, MAX_MESSAGE_LEN, checkGate };
