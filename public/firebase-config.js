// Firebase 웹 앱 설정. 이 값은 프로젝트를 식별하는 공개 값이며 비밀이 아니다.
// 접근 통제는 firestore.rules(보안 규칙)와 Cloud Functions가 담당한다.
// (학생 대상 서비스이므로 Analytics는 사용하지 않는다.)
export const firebaseConfig = {
  apiKey: "AIzaSyD2djwjvlxipXzupiVh_37NIlaohrh9jno",
  authDomain: "knue-socialstudies-ai-eps.firebaseapp.com",
  projectId: "knue-socialstudies-ai-eps",
  storageBucket: "knue-socialstudies-ai-eps.firebasestorage.app",
  messagingSenderId: "233366668108",
  appId: "1:233366668108:web:0b455c41fc2b83e8c285e9",
};
