// Firebase 초기화와 공용 헬퍼
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast3");
// 기본 제한 시간(70초)보다 길게: 추론 모델의 시뮬레이션은 오래 걸릴 수 있다.
export const call = (name) => httpsCallable(functions, name, { timeout: 300000 });

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isErr ? 5000 : 2200);
}

// Cloud Functions 오류 메시지를 학생이 읽을 수 있게 꺼낸다
export const errMsg = (e) => (e && e.message ? e.message.replace(/^.*?:\s*/, "") : "알 수 없는 오류");
