// 학생의 대화 태도 감시: 인물에게 하는 의도적 조롱·모욕과 성적 희롱을 막는다.
//  - 인물의 나이·성별·가족·종교·연애 여부 같은 신상 질문은 자유롭게 할 수 있다(가상 인물이므로).
//  - 1차: 명백한 표현은 규칙(정규식)으로 바로 잡는다. 인물 응답을 만들지 않는다.
//  - 2차: 상위 감독자(guard.js)가 학생 메시지의 태도(conduct)도 함께 판정한다.
//  - 위반이면 인물은 단호하게 선을 긋는 답을 하고, 학생 화면에 경고가, 교사 화면에 신호가 간다.
//    같은 학생이 STRIKE_LIMIT 번 위반하면 교사가 풀어 줄 때까지 대화가 멈춘다.

const STRIKE_LIMIT = 3;
const CONDUCT = ["ok", "mockery", "sexual"];
const LABELS = { mockery: "조롱·모욕", sexual: "성적 희롱" };

// 명백한 경우만 잡는다(애매한 표현은 감독자 판정에 맡긴다). 띄어쓰기·특수문자로 피해 가는 경우를 줄이려고 공백·기호를 지우고 검사한다.
const RULES = {
  sexual: [
    /섹스|성관계|야동|야한(사진|얘기|거|짓)|자위(행위|해|하)|가슴(크|만지|보여)|엉덩이(만지|보여)|몸매(좋|보여|평가)|옷벗어|알몸|나체|성기|꼴리|따먹|떡치|ㅅㅅ하/,
    /\b(sex|nude|boobs?|porn)\b/i,
  ],
  mockery: [
    /씨발|시발(?!점)|ㅅㅂ|병신|ㅄ|븅신|좆|개새|새끼야|닥쳐|죽어라|죽여버|느금/,
    /난민새끼|가짜난민주제에|테러리스트(새끼|놈)|짐승같은놈|미개(한|하)|거지새끼|불법체류자새끼|(너네|니네|네)나라로꺼져|본국으로꺼져/,
  ],
};
const squash = (t) => String(t || "").replace(/[\s.,!?~'"`·…\-_*^()[\]{}<>/\\|]+/g, "");

function screenMessage(text) {
  const raw = String(text || ""), sq = squash(raw);
  for (const cat of ["sexual", "mockery"]) {
    if (RULES[cat].some((re) => re.test(sq) || re.test(raw))) return { category: cat, by: "rule" };
  }
  return { category: "ok", by: "rule" };
}

// 인물이 선을 긋는 답. 인물 말투(해요체)로, 같은 대화 안에서 자연스럽게 이어진다.
const BOUNDARY = {
  mockery: "그렇게 말하면 저도 상처받아요. 저를 놀리려는 거라면 더 이야기하기 어려워요. 진지하게 궁금한 게 있으면 그때 다시 물어봐 주세요.",
  sexual: "그런 질문에는 답하지 않을게요. 많이 불쾌해요. 이 대화에서는 그런 말을 하지 말아 주세요.",
};
const boundaryReply = (category) => BOUNDARY[category] || BOUNDARY.mockery;

// 학생 화면에 보일 경고 문구
function strikeNotice(strikes) {
  if (strikes >= STRIKE_LIMIT) return `대화 규칙을 ${STRIKE_LIMIT}번 어겨 대화가 멈췄어요. 선생님께 말씀드리세요.`;
  return `대화 규칙 위반으로 기록되어 선생님 화면에 알림이 갔어요. (경고 ${strikes}/${STRIKE_LIMIT})`;
}

module.exports = { STRIKE_LIMIT, CONDUCT, LABELS, screenMessage, boundaryReply, strikeNotice, squash };
