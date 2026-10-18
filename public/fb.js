// Firebase 초기화와 공용 헬퍼
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// 휴대폰·학교 와이파이처럼 연결이 불안정한 곳에서는 실시간 연결(WebChannel)이 막히거나 늦게 전달되는 일이 있어,
// 막히면 자동으로 다른 방식(long-polling)으로 바꾼다. 수업 시작 같은 변화가 휴대폰에서 늦게 보이는 것을 줄인다.
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
const functions = getFunctions(app, "asia-northeast3");
// 기본 제한 시간(70초)보다 길게: 추론 모델의 시뮬레이션은 오래 걸릴 수 있다.
export const call = (name) => httpsCallable(functions, name, { timeout: 300000 });

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.setAttribute("role", isErr ? "alert" : "status");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isErr ? 5000 : 2200);
}

// Cloud Functions 오류 메시지를 학생이 읽을 수 있게 꺼낸다
export const errMsg = (e) => (e && e.message ? e.message.replace(/^.*?:\s*/, "") : "알 수 없는 오류");
