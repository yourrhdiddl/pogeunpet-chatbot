# 포근펫 AI 상담 챗봇

반려동물 용품을 파는 가상 쇼핑몰 **포근펫**의 고객 상담 챗봇입니다.
주문·배송·재고처럼 데이터로 답할 수 있는 질문은 AI 없이 바로 답하고, 그 밖의 질문은 Claude가 상점 데이터를 근거로 답합니다.

> 상품·주문·고객 정보는 모두 실습용 가상 데이터입니다.

## 주요 기능

| 구분 | 기능 |
| --- | --- |
| 상담 | 주문번호·운송장 조회, 재고 확인(카테고리 → 상품), 상품 추천, AI 자유 상담, 긴 답변 말풍선 나누기, 주제 밖 질문 거절 |
| 관리자 | `Ctrl+Shift+A`로 진입 (배포 주소: Google 로그인 + 관리자 등록, 로컬: 비밀번호), 상품·재고·주문·배송 편집, 대화 기록, 답변별 피드백 |
| 고도화 | 관리자 피드백을 '운영자 지침'으로 모아 다음 AI 답변에 반영 |

## 폴더 구조

```
public/            배포되는 화면
  index.html       포근펫 상담 챗봇
  tabs.html        탭별 챗봇 실습 (UI만 / 자유 대화 / 쇼핑몰 / 노래 추천)
  flowcharts.html  챗봇 답변 흐름도
functions/         Blaze 요금제용 서버 함수 (지금은 배포하지 않음)
firestore.rules    Firestore 보안 규칙
serve.cjs          로컬 테스트 서버 (피드백 저장, AI 요청 중계)
docs/reports/      테스트 보고서 (HTML, PDF, 화면 캡처)
```

## 배포 (Firebase, 무료 Spark 요금제)

배포 주소: https://pogeunpet-chatbot.web.app

결제 수단 없이 동작하도록 서버 함수 없이 Hosting과 Firestore만 씁니다.

| 데이터 | 저장 위치 | 누가 읽고 쓰나 |
| --- | --- | --- |
| 상품·재고 | Firestore `products`, `inventory` | 누구나 읽기, 관리자만 수정 |
| 주문·배송 원본 | Firestore `orders`, `shipments` | 관리자만 |
| 조회용 공개 사본 | Firestore `lookup` (`ORD-1003`, `T-운송장번호`) | 누구나 문서 1개씩만 조회, 목록 보기는 막힘. 주문자 이름은 가리고 연락처는 넣지 않음. 관리자가 주문·배송을 고치면 자동으로 다시 만들어짐 |
| 대화 기록 | Firestore `logs` | 고객은 추가만, 관리자만 읽기 |
| 피드백·지침 | Firestore `feedback` | 관리자만 |
| Claude API 키 | Firestore `secrets/claude` | 관리자만 읽기·쓰기 |

**무료 요금제의 한계**: 키를 숨긴 채 모든 고객이 AI를 쓰려면 키를 대신 들고 호출해 줄 서버가 필요하고, Firebase에서는 그 서버(Cloud Functions)가 유료입니다. 그래서 AI 답변은 **로그인한 관리자에게만** 켜지고, 고객 질문은 주문·운송장 조회, 상품 검색, 추천, 배송·교환 안내로 답합니다. `functions/` 폴더는 나중에 Blaze 요금제로 바꿀 때 쓸 서버 코드입니다(지금은 배포하지 않음).

### 처음 한 번 설정 (모두 무료)

1. **Google 로그인 켜기**: [Authentication › 로그인 방법](https://console.firebase.google.com/project/pogeunpet-chatbot/authentication/providers)에서 Google을 사용 설정합니다.
2. **관리자 등록**: 배포 주소에서 `Ctrl+Shift+A` → Google 로그인 → 화면에 나온 UID를 복사해, [Firestore 콘솔](https://console.firebase.google.com/project/pogeunpet-chatbot/firestore)에서 `admins` 컬렉션에 그 UID를 문서 ID로 하는 문서를 만듭니다(필드는 비워도 됨).
3. **API 키 (선택)**: 관리자 화면 위쪽 Claude API 키 칸에 넣고 저장합니다. 관리자 계정에서만 AI 답변이 켜집니다.

### 배포 명령

```bash
npx -y firebase-tools deploy --project pogeunpet-chatbot
```

화면만 바꿨을 때는 `--only hosting`, 보안 규칙만 바꿨을 때는 `--only firestore:rules`를 붙입니다.

## 로컬에서 실행

Node 18 이상이 필요합니다. 설치할 패키지는 없습니다.

```bash
node serve.cjs
```

http://localhost:5500 에 접속합니다. AI 상담을 쓰려면 관리자 화면에 Claude API 키를 넣거나, 서버를 실행할 때 환경변수 `ANTHROPIC_API_KEY`를 설정합니다.
