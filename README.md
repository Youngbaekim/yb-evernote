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

## 개발 단계

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | 준비 (저장소, Firebase, 화면 골격) | 완료 |
| 1 | 텍스트 노트 (폰트, 체크박스, 형광펜, 그림 붙여넣기) | 완료 (v0.1.0) |
| 2 | 펜 노트 (필압, 벡터 획 묶음 저장) | 완료 (v0.2.0) |
| 3 | 동기화 (Google 로그인, Firestore) | 예정 |
| 4 | 배포·점검 (PWA 설치, 기기 점검) | 예정 |
