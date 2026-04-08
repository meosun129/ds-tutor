const http = require('http')
const express = require('express')
const cors = require('cors')
const { Server: SocketIO } = require('socket.io')
const db = require('./db')
const { authenticateToken, requireTutor } = require('./middleware')
const authRouter = require('./auth')
const weeksRouter = require('./weeks')
const quizzesRouter = require('./quizzes')
const sessionsRouter = require('./sessions')
require('dotenv').config()

const app    = express()
const server = http.createServer(app)
const io     = new SocketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
})
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())
app.use(express.static('public'))

// 라우터 등록
app.use('/auth', authRouter)
app.use('/weeks', weeksRouter)
app.use('/quizzes', quizzesRouter)
app.use('/sessions', sessionsRouter)

// ── DB 스키마 자동 생성 ──────────────────────────────────────
;(async () => {
  const tables = [
    // users
    `CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      email      VARCHAR UNIQUE NOT NULL,
      password   VARCHAR NOT NULL,
      name       VARCHAR NOT NULL,
      role       VARCHAR NOT NULL CHECK (role IN ('tutor', 'student')),
      created_at TIMESTAMP DEFAULT NOW()
    )`,

    // weeks: 주차별 학습 단위
    `CREATE TABLE IF NOT EXISTS weeks (
      id         SERIAL PRIMARY KEY,
      week_no    INT UNIQUE NOT NULL,
      title      VARCHAR NOT NULL,
      pdf_text   TEXT,
      pdf_files  JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW()
    )`,
    `ALTER TABLE weeks ADD COLUMN IF NOT EXISTS pdf_files JSONB DEFAULT '[]'`,

    // quizzes: OX / 객관식 / 코드추적 퀴즈
    `CREATE TABLE IF NOT EXISTS quizzes (
      id            SERIAL PRIMARY KEY,
      week_id       INT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
      type          VARCHAR NOT NULL CHECK (type IN ('ox', 'multiple', 'code_trace')),
      question      TEXT NOT NULL,
      choices_json  TEXT,
      answer        TEXT NOT NULL,
      explanation   TEXT,
      approved      BOOLEAN DEFAULT false,
      created_at    TIMESTAMP DEFAULT NOW()
    )`,

    // quiz_results: 학생 퀴즈 제출 기록
    `CREATE TABLE IF NOT EXISTS quiz_results (
      id           SERIAL PRIMARY KEY,
      user_id      INT NOT NULL REFERENCES users(id),
      quiz_id      INT NOT NULL REFERENCES quizzes(id),
      user_answer  TEXT NOT NULL,
      is_correct   BOOLEAN NOT NULL,
      submitted_at TIMESTAMP DEFAULT NOW()
    )`,

    // sessions: 튜터링 세션 기록
    `CREATE TABLE IF NOT EXISTS sessions (
      id                  SERIAL PRIMARY KEY,
      week_id             INT NOT NULL REFERENCES weeks(id),
      date                DATE NOT NULL,
      start_time          TIME,
      end_time            TIME,
      topics_covered_json TEXT,
      tutor_note          TEXT,
      created_at          TIMESTAMP DEFAULT NOW()
    )`,

    // session_attendance: 세션 참석 학생
    `CREATE TABLE IF NOT EXISTS session_attendance (
      id         SERIAL PRIMARY KEY,
      session_id INT NOT NULL REFERENCES sessions(id),
      user_id    INT NOT NULL REFERENCES users(id)
    )`,

    // understanding: 학생별 세션 이해도 체크
    `CREATE TABLE IF NOT EXISTS understanding (
      id         SERIAL PRIMARY KEY,
      session_id INT NOT NULL REFERENCES sessions(id),
      user_id    INT NOT NULL REFERENCES users(id),
      topic      VARCHAR NOT NULL,
      level      VARCHAR NOT NULL CHECK (level IN ('good', 'confused', 'lost')),
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  ]

  for (const sql of tables) {
    await db.query(sql).catch(err =>
      console.error('[DB init] 테이블 생성 실패:', err.message)
    )
  }

  // 자주 쓰이는 컬럼에 인덱스 추가
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_quizzes_week_id         ON quizzes(week_id)`,
    `CREATE INDEX IF NOT EXISTS idx_quiz_results_user_id    ON quiz_results(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_quiz_results_quiz_id    ON quiz_results(quiz_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_week_id        ON sessions(week_id)`,
    `CREATE INDEX IF NOT EXISTS idx_attendance_session_id   ON session_attendance(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_understanding_session   ON understanding(session_id, user_id)`,
  ]
  for (const sql of indexes) {
    await db.query(sql).catch(() => {})
  }

  console.log('[DB] 스키마 초기화 완료')
})()

// ── 기본 라우트 ────────────────────────────────────────────

// GET /health — 서버 상태 확인 (Railway healthcheck, 인증 없음)
app.get('/health', (req, res) => {
  res.json({ ok: true })
})

// GET /users/me — 내 정보 조회 (인증 필요)
app.get('/users/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, email, name, role, created_at FROM users WHERE id = $1',
      [req.user.id]
    )
    if (rows.length === 0) return res.status(404).json({ error: '사용자를 찾을 수 없어요' })
    res.json({ data: rows[0] })
  } catch (err) {
    console.error('[GET /users/me]', err)
    res.status(500).json({ error: '서버 오류가 발생했어요' })
  }
})

// GET /users/students — 학생 목록 조회 (tutor 전용)
app.get('/users/students', authenticateToken, requireTutor, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, email, name, created_at FROM users WHERE role = 'student' ORDER BY name ASC"
    )
    res.json({ data: rows })
  } catch (err) {
    console.error('[GET /users/students]', err)
    res.status(500).json({ error: '서버 오류가 발생했어요' })
  }
})

// ── Socket.io 이벤트 ────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket.io] 클라이언트 연결: ${socket.id}`)

  // 특정 주차 또는 세션 룸에 참여
  socket.on('join', (room) => {
    socket.join(room)
    console.log(`[Socket.io] ${socket.id} → 룸 참여: ${room}`)
  })

  socket.on('disconnect', () => {
    console.log(`[Socket.io] 클라이언트 연결 해제: ${socket.id}`)
  })
})

// io 인스턴스를 라우터에서 접근할 수 있도록 app에 저장
app.set('io', io)

// ── 전역 에러 핸들러 ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err)
  res.status(500).json({ error: '서버 오류가 발생했어요' })
})

server.listen(PORT, () => {
  console.log(`ds-tutor server running on http://localhost:${PORT}`)
})
