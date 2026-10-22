// 체험용 인물 대답 고르기. 진짜 AI 대신, 인물의 편지(1인칭 문단)와 입장 문장 가운데
// 학생의 질문과 가장 가까운 것을 골라 들려 준다. 한 번 한 말은 다시 하지 않고, 못 고르면 아직 안 한 이야기를 이어 간다.
const STOP = new Set(["어떻", "떻게", "무엇", "뭐예", "있어", "있나", "하세", "세요", "해요", "이에", "에요", "는지", "나요", "하고", "까요", "그런", "그리", "이야", "주세", "어요", "싶어", "습니", "니다", "합니", "어떤", "그럼", "혹시", "그래"]);
const grams = (s) => {
  const out = new Set();
  for (const w of String(s).toLowerCase().replace(/[^가-힣a-z0-9\s]/g, " ").split(/\s+/)) {
    for (let i = 0; i + 2 <= w.length; i++) { const g = w.slice(i, i + 2); if (!STOP.has(g)) out.add(g); }
  }
  return out;
};
// 질문의 뜻(의도)별로 '이런 낱말이 든 문단'을 더 좋게 보고, 문단 위치(앞=소개, 뒤=바람)도 조금 따진다
const INTENTS = [
  { id: "hard", ask: /힘든|힘들|어려|고민|걱정|불안|무서|막막|문제|곤란|괴로|속상/, boost: /힘들|힘든|어렵|걱정|불안|무섭|무서|막막|문제|괴롭|속상|서운|불편|두렵|그리|잃|떠나|겁이|못 ?했|못 ?해|줄었|떨어졌|반대|갈등/, pos: (i, n) => (i >= 2 && i < n - 1 ? 1 : 0) },
  { id: "hope", ask: /바라|원하|소원|희망|앞으로|바람|기대|부탁/, boost: /바라|원하|바람|싶어|희망|부탁|해 주|했으면|필요해|좋겠/, pos: (i, n) => (i >= n - 2 ? 2 : 0) },
  { id: "job", ask: /무슨 ?일|어떤 ?일|직업|하는 ?일|뭐 ?하|소개|누구|어디 ?사|나이|고향|가족/, boost: /저는|제가|살|나고|일해|일을|가족|고향|맡고|하고 있/, pos: (i) => (i < 2 ? 4 - i * 2 : 0) },
  { id: "opinion", ask: /생각|의견|입장|찬성|반대|어떻게 ?보|옳|맞다고|그렇다고/, boost: /생각|반대|찬성|옳|맞|틀|입장|문제라고/, views: true, pos: () => 0 },
];
const GREET = /^\s*(안녕|하이|반가|처음 ?뵙|ㅎㅇ|hello|hi)\b|^\s*(안녕|반가)/i;
const THANKS = /고마|감사|수고|도움이 ?됐|잘 ?알겠/;
const AI_Q = /(AI|인공지능|챗봇|진짜 ?사람|실제 ?사람|사람이야|사람이에요|가짜)/i;
const RUDE = /(시발|씨발|병신|꺼져|죽어|개새|미친|엿먹|ㅅㅂ|ㅂㅅ)/;

const firstSentences = (t, n = 2) => (t.match(/[^.!?。]+[.!?]?/g) || [t]).slice(0, n).join("").trim();
const closing = (t) => /궁금한|물어보|물어봐|언제든|편하게 ?이야기/.test(t) && t.length < 120;

// say: {hello, paras, views}, past: 지금까지 인물이 한 말 목록
export function demoReply(question, say, past = []) {
  const q = String(question || "").trim();
  const said = (t) => past.some((p) => p.includes(t.slice(0, 18)));
  if (RUDE.test(q)) return "그런 말은 듣기 힘들어요. 다른 질문으로 이야기해 주세요.";
  if (AI_Q.test(q)) return "저는 실제 사건들을 바탕으로 만든 가상의 인물이에요. 그래도 제 처지와 생각에 대해서는 편하게 물어봐 주세요.";
  if (GREET.test(q) && !past.length && q.length < 30 && !/일|힘든|바라/.test(q)) return say.hello;
  if (GREET.test(q) && past.length && q.length < 12) return "네, 반가워요. 궁금한 걸 편하게 물어봐 주세요.";
  if (THANKS.test(q) && q.length < 30) return "도움이 됐다니 다행이에요. 더 궁금한 게 있으면 물어봐 주세요.";

  const paras = say.paras.filter((p) => !closing(p));
  const pool = [...paras.map((t) => ({ t, view: false })), ...say.views.map((t) => ({ t, view: true }))];
  const qg = grams(q);
  let intents = INTENTS.filter((i) => i.ask.test(q));
  if (intents.some((i) => i.id === "hard" || i.id === "hope")) intents = intents.filter((i) => i.id !== "job"); // '힘든 일이 뭐예요'를 직업 질문으로 보지 않는다
  const scored = pool.filter((x) => !said(x.t)).map((x, i) => {
    let s = 0; for (const g of grams(x.t)) if (qg.has(g)) s++;
    for (const it of intents) { if (it.boost.test(x.t)) s += 3; if (it.views && x.view) s += 2; if (!x.view) s += it.pos(i, paras.length); }
    return { ...x, s, i };
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const best = scored[0];
  if (!best) return "그 이야기는 아까 거의 다 한 것 같아요. 다른 것도 물어봐 주세요. 예를 들어 그때 어떤 마음이었는지, 앞으로 바라는 것은 무엇인지요.";
  if (best.s >= 2 || intents.length) return best.t;
  // 마땅한 말이 없으면: 모른다고 하고, 아직 안 한 이야기를 이어 간다
  const next = scored.filter((x) => !x.view).sort((a, b) => a.i - b.i)[0] || best;
  return `음, 그건 제가 딱 잘라 말하기 어려워요. 대신 이런 이야기를 해 볼게요. ${next.t}`;
}

// 문장 앞부분을 따옴표로 짚을 때 쓴다
export const snippet = (t, n = 18) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
