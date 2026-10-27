# YB-EverNote

PC · Android · iOS에서 쓰는 개인 노트 앱 (PWA)

## 실행 방법 (PowerShell)

```
cd C:\dev\yb-evernote
npm install      # 처음 한 번만
npm run dev      # 개발 서버 실행 → 화면에 나오는 주소를 브라우저로 열기
```

- 종료: PowerShell 창에서 `Ctrl + C`
- 배포: `main` 브랜치에 올리면 GitHub Actions가 자동으로 GitHub Pages에 배포
- 새 버전 안내를 띄우려면 `public/sw.js`의 `VERSION`을 올린 뒤 배포

## 개발 단계

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | 준비 (저장소, Firebase, 화면 골격) | 완료 |
| 1 | 텍스트 노트 (폰트, 체크박스, 형광펜, 그림 붙여넣기) | 완료 (v0.1.0) |
| 2 | 펜 노트 (필압, 벡터 획 묶음 저장) | 완료 (v0.2.0) |
| 3 | 동기화 (Google 로그인, Firestore) | 완료 (v0.3.0) |
| 4 | 배포·점검 (PWA 설치, 기기 점검) | 완료 (v0.4.x) |
| 5 | 고도화 (백업·복원, 인쇄·PDF, 본문 검색, 잠금 노트, 그림 크기 조절, 필기 블록 이동) | 진행 중 (v0.5.0) |
