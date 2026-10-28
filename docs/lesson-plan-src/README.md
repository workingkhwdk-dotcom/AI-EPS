# 수업지도안 생성 도구

`docs/lesson-plan.html`(A4 인쇄용 수업지도안)을 만드는 스크립트입니다. 앱 코드(`functions/`, `public/`)는 읽기만 하고 수정하지 않습니다.

- `build.js` 지도안 본문 구성과 HTML 출력 (`node build.js`)
- `apx.js` 부록 생성(앱의 사건 파일·프롬프트 코드에서 직접 가져옴)
- `plan.css` 인쇄 스타일
- `img/` 부록 1에 쓰는 웹앱 화면(시연용 예시 데이터로 촬영)
- `seed.js`, `cap.js`, `capt.js` 화면 촬영용(Playwright, 시연 데이터)
- `pdf.js` 인쇄 결과 점검용 PDF 만들기

인쇄: Chrome/Edge에서 A4, 머리글·바닥글 끄기, 배경 그래픽 켜기.
