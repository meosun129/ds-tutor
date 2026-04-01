# CLAUDE.md — ds-tutor

자료구조 맞춤형 튜터링 앱. 상명대 게임전공 수업(성한울 교수님) 기반.

## 프로젝트 개요

- **목적**: 튜터 1명 + 학생 3명 고정. PDF 업로드 → AI 퀴즈 자동생성 → 학생 퀴즈 풀기 → 튜터 대시보드 → 상명튜터링 활동보고서 자동생성
- **언어**: C언어 기반 자료구조 수업 (포인터가 핵심 관문)
- **포트**: 3001 (just 앱이 3000 사용)
- **DB**: ds_tutor_db (PostgreSQL)
- **배포**: Railway 예정

## 실행 방법

```bash
npm install     # 최초 1회
npm start       # http://localhost:3001
```

**필수 `.env`:**
```
DB_USER=postgres
DB_PASSWORD=bigdata
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ds_tutor_db
PORT=3001
JWT_SECRET=supersecretkey123
OPENROUTER_API_KEY=sk-or-...
```

## 아키텍처

### 백엔드 파일 구조
| 파일 | 역할 |
|------|------|
| `server.js` | Express 앱 진입점, DB 스키마 자동생성, 기본 라우트 |
| `auth.js` | 회원가입/로그인 (tutor 1인 제한, role 포함 JWT) |
| `middleware.js` | `authenticateToken` + `requireTutor` |
| `db.js` | PostgreSQL Pool (DATABASE_URL 우선, 없으면 개별 env) |
| `weeks.js` | 주차 관리 + PDF 업로드 API _(예정)_ |
| `quizzes.js` | 퀴즈 CRUD + 승인 API _(예정)_ |
| `sessions.js` | 세션 기록 + 보고서 생성 API _(예정)_ |
| `ai.js` | PDF 파싱 + OpenRouter AI 퀴즈 생성 파이프라인 _(예정)_ |

### 프론트엔드
- `public/index.html`, `public/script.js`, `public/style.css`
- Vanilla JS SPA, JWT → role 디코딩 → 튜터/학생 뷰 분기
- Socket.io 실시간 연결

### DB 스키마
```
users            — id, email, password, name, role(tutor|student)
weeks            — id, week_no, title, pdf_text
quizzes          — id, week_id, type(ox|multiple|code_trace), question, choices_json, answer, explanation, approved
quiz_results     — id, user_id, quiz_id, user_answer, is_correct
sessions         — id, week_id, date, start_time, end_time, topics_covered_json, tutor_note
session_attendance — id, session_id, user_id
understanding    — id, session_id, user_id, topic, level(good|confused|lost)
```

## 역할 & 권한

| 기능 | tutor | student |
|------|-------|---------|
| PDF 업로드 | ✅ | ❌ |
| AI 퀴즈 생성/승인 | ✅ | ❌ |
| 퀴즈 풀기 | ❌ | ✅ |
| 대시보드 (학생 결과 비교) | ✅ | ❌ |
| 내 약점 확인 | ❌ | ✅ |
| 세션 시작/종료 | ✅ | ❌ |
| 이해도 체크 | ❌ | ✅ |
| 보고서 다운로드 | ✅ | ❌ |

## 코드 컨벤션

- `async/await` 사용, callback 금지
- 에러 응답: `{ error: '한국어 메시지' }` 형식 통일
- 성공 응답: `{ data: ... }` 형식 통일
- 라우트 핸들러는 얇게, 비즈니스 로직은 helper 함수로 분리
- SQL은 반드시 파라미터화 (`$1`, `$2`) — 문자열 보간 금지
- tutor 전용 라우트: `authenticateToken, requireTutor` 미들웨어 체인

## 커리큘럼 (실제 PDF 기반)
| 주차 | 주제 | 핵심 |
|------|------|------|
| 2주차 | 자료구조 개념 + 포인터 | 포인터 = 모든 구조의 기반 |
| 3주차 | 배열 + 구조체 | 배열이름=상수포인터 |
| 4주차 | 스택 | LIFO, push/pop, overflow/underflow |
| 5주차~ | 연결 리스트 | ADT → 배열구현 → 연결구현 |

## AI 퀴즈 파이프라인
1. PDF 업로드 (multer)
2. Python pypdf로 텍스트 추출 (child_process)
3. OpenRouter API → JSON 퀴즈 반환
4. DB 저장 (approved=false)
5. 튜터 검토 → 승인 → 학생 출제

**퀴즈 유형**: `ox` / `multiple` (객관식) / `code_trace` (코드 추적)
**AI 모델**: `nvidia/nemotron-3-super-120b-a12b:free`

## 테스트 없음
`npm test`는 stub. 수동 테스트로 진행.
