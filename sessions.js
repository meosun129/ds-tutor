const express = require('express')
const db = require('./db')
const { authenticateToken, requireTutor } = require('./middleware')

const router = express.Router()

// ── 헬퍼 ────────────────────────────────────────────────────

async function getSessionById(id) {
  const { rows } = await db.query(
    `SELECT s.*, w.week_no, w.title AS week_title
     FROM sessions s
     JOIN weeks w ON w.id = s.week_id
     WHERE s.id = $1`,
    [id]
  )
  return rows[0] || null
}

function requireStudent(req, res, next) {
  if (req.user?.role !== 'student') {
    return res.status(403).json({ error: '학생만 이해도를 등록할 수 있어요' })
  }
  next()
}

function levelToKorean(level) {
  if (level === 'good') return '잘 이해함'
  if (level === 'confused') return '헷갈림'
  if (level === 'lost') return '이해 못함'
  return level
}

// ── 세션 관리 (tutor 전용) ───────────────────────────────────

// GET /sessions — 세션 목록 (weeks JOIN)
router.get('/', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, w.week_no, w.title AS week_title
       FROM sessions s
       JOIN weeks w ON w.id = s.week_id
       ORDER BY s.date DESC, s.start_time DESC`
    )
    res.json({ data: rows })
  } catch (err) {
    next(err)
  }
})

// POST /sessions — 세션 생성
router.post('/', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const { week_id, date, start_time, topics_covered_json, tutor_note } = req.body

    if (!week_id || !date) {
      return res.status(400).json({ error: '주차 ID와 날짜는 필수예요' })
    }

    // week 존재 여부 확인
    const { rows: weekRows } = await db.query('SELECT id FROM weeks WHERE id = $1', [week_id])
    if (weekRows.length === 0) {
      return res.status(404).json({ error: '해당 주차를 찾을 수 없어요' })
    }

    const topicsJson = topics_covered_json
      ? (typeof topics_covered_json === 'string' ? topics_covered_json : JSON.stringify(topics_covered_json))
      : null

    const { rows } = await db.query(
      `INSERT INTO sessions (week_id, date, start_time, topics_covered_json, tutor_note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [week_id, date, start_time || null, topicsJson, tutor_note || null]
    )
    res.status(201).json({ data: rows[0] })
  } catch (err) {
    next(err)
  }
})

// PUT /sessions/:id — 세션 수정 (end_time, tutor_note, topics_covered_json)
router.put('/:id', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const session = await getSessionById(req.params.id)
    if (!session) return res.status(404).json({ error: '세션을 찾을 수 없어요' })

    const { end_time, tutor_note, topics_covered_json } = req.body

    const newEndTime = end_time !== undefined ? end_time : session.end_time
    const newTutorNote = tutor_note !== undefined ? tutor_note : session.tutor_note

    let newTopicsJson = session.topics_covered_json
    if (topics_covered_json !== undefined) {
      newTopicsJson = topics_covered_json
        ? (typeof topics_covered_json === 'string' ? topics_covered_json : JSON.stringify(topics_covered_json))
        : null
    }

    const { rows } = await db.query(
      `UPDATE sessions
       SET end_time = $1, tutor_note = $2, topics_covered_json = $3
       WHERE id = $4
       RETURNING *`,
      [newEndTime, newTutorNote, newTopicsJson, req.params.id]
    )
    res.json({ data: rows[0] })
  } catch (err) {
    next(err)
  }
})

// DELETE /sessions/:id — 세션 삭제
router.delete('/:id', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const session = await getSessionById(req.params.id)
    if (!session) return res.status(404).json({ error: '세션을 찾을 수 없어요' })

    await db.query('DELETE FROM sessions WHERE id = $1', [req.params.id])
    res.json({ data: { message: '세션이 삭제됐어요' } })
  } catch (err) {
    next(err)
  }
})

// ── 참석 관리 (tutor 전용) ───────────────────────────────────

// POST /sessions/:id/attendance — 참석 학생 설정 (덮어쓰기)
router.post('/:id/attendance', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const session = await getSessionById(req.params.id)
    if (!session) return res.status(404).json({ error: '세션을 찾을 수 없어요' })

    const { student_ids } = req.body
    if (!Array.isArray(student_ids)) {
      return res.status(400).json({ error: 'student_ids는 배열이어야 해요' })
    }

    // 기존 참석 기록 삭제
    await db.query('DELETE FROM session_attendance WHERE session_id = $1', [req.params.id])

    // 새 참석 기록 삽입
    if (student_ids.length > 0) {
      // 학생 role 검증
      const { rows: validStudents } = await db.query(
        `SELECT id FROM users WHERE id = ANY($1::int[]) AND role = 'student'`,
        [student_ids]
      )
      if (validStudents.length !== student_ids.length) {
        return res.status(400).json({ error: '유효하지 않은 학생 ID가 포함되어 있어요' })
      }

      const insertValues = student_ids
        .map((_, i) => `($1, $${i + 2})`)
        .join(', ')
      await db.query(
        `INSERT INTO session_attendance (session_id, user_id) VALUES ${insertValues}`,
        [req.params.id, ...student_ids]
      )
    }

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email
       FROM session_attendance sa
       JOIN users u ON u.id = sa.user_id
       WHERE sa.session_id = $1
       ORDER BY u.name ASC`,
      [req.params.id]
    )
    res.json({ data: rows })
  } catch (err) {
    next(err)
  }
})

// GET /sessions/:id/attendance — 참석 학생 목록 조회
router.get('/:id/attendance', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const session = await getSessionById(req.params.id)
    if (!session) return res.status(404).json({ error: '세션을 찾을 수 없어요' })

    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email
       FROM session_attendance sa
       JOIN users u ON u.id = sa.user_id
       WHERE sa.session_id = $1
       ORDER BY u.name ASC`,
      [req.params.id]
    )
    res.json({ data: rows })
  } catch (err) {
    next(err)
  }
})

// ── 이해도 체크 (student 전용) ───────────────────────────────

// POST /sessions/:id/understanding — 이해도 등록/업데이트 (upsert)
router.post('/:id/understanding', authenticateToken, requireStudent, async (req, res, next) => {
  try {
    const session = await getSessionById(req.params.id)
    if (!session) return res.status(404).json({ error: '세션을 찾을 수 없어요' })

    const { topic, level } = req.body
    if (!topic || !level) {
      return res.status(400).json({ error: '주제와 이해도 수준을 입력해주세요' })
    }

    const validLevels = ['good', 'confused', 'lost']
    if (!validLevels.includes(level)) {
      return res.status(400).json({ error: '이해도는 good, confused, lost 중 하나여야 해요' })
    }

    // 기존 레코드 확인 후 upsert
    const { rows: existing } = await db.query(
      `SELECT id FROM understanding
       WHERE session_id = $1 AND user_id = $2 AND topic = $3`,
      [req.params.id, req.user.id, topic]
    )

    let rows
    if (existing.length > 0) {
      const result = await db.query(
        `UPDATE understanding SET level = $1 WHERE id = $2 RETURNING *`,
        [level, existing[0].id]
      )
      rows = result.rows
    } else {
      const result = await db.query(
        `INSERT INTO understanding (session_id, user_id, topic, level)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.params.id, req.user.id, topic, level]
      )
      rows = result.rows
    }

    res.json({ data: rows[0] })
  } catch (err) {
    next(err)
  }
})

// GET /sessions/:id/understanding — 세션 이해도 전체 조회 (tutor 전용)
router.get('/:id/understanding', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const session = await getSessionById(req.params.id)
    if (!session) return res.status(404).json({ error: '세션을 찾을 수 없어요' })

    const { rows } = await db.query(
      `SELECT u.id, u.session_id, u.user_id, u.topic, u.level, u.created_at,
              usr.name AS student_name, usr.email AS student_email
       FROM understanding u
       JOIN users usr ON usr.id = u.user_id
       WHERE u.session_id = $1
       ORDER BY usr.name ASC, u.topic ASC`,
      [req.params.id]
    )
    res.json({ data: rows })
  } catch (err) {
    next(err)
  }
})

// ── 보고서 (tutor 전용) ──────────────────────────────────────

// GET /sessions/:id/report — 활동보고서 텍스트 다운로드
router.get('/:id/report', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const session = await getSessionById(req.params.id)
    if (!session) return res.status(404).json({ error: '세션을 찾을 수 없어요' })

    // 참석 학생
    const { rows: attendees } = await db.query(
      `SELECT u.name, u.email
       FROM session_attendance sa
       JOIN users u ON u.id = sa.user_id
       WHERE sa.session_id = $1
       ORDER BY u.name ASC`,
      [req.params.id]
    )

    // 이해도
    const { rows: understandings } = await db.query(
      `SELECT u.topic, u.level, usr.name AS student_name
       FROM understanding u
       JOIN users usr ON usr.id = u.user_id
       WHERE u.session_id = $1
       ORDER BY usr.name ASC, u.topic ASC`,
      [req.params.id]
    )

    // 퀴즈 결과 — 세션 날짜 기준으로 해당 날 제출된 결과 집계
    const { rows: quizResults } = await db.query(
      `SELECT usr.name, usr.id AS user_id,
              COUNT(*) AS total,
              SUM(CASE WHEN qr.is_correct THEN 1 ELSE 0 END) AS correct
       FROM quiz_results qr
       JOIN users usr ON usr.id = qr.user_id
       WHERE qr.submitted_at::date = $1
       GROUP BY usr.id, usr.name
       ORDER BY usr.name ASC`,
      [session.date]
    )

    // 보고서 텍스트 조립
    const lines = []
    lines.push('===================================')
    lines.push('상명대학교 튜터링 활동 보고서')
    lines.push('===================================')
    lines.push('')
    lines.push('[세션 정보]')
    lines.push(`주차: ${session.week_no}주차 - ${session.week_title}`)
    lines.push(`날짜: ${session.date}`)
    lines.push(`시간: ${session.start_time || '미입력'} ~ ${session.end_time || '미입력'}`)
    lines.push('')

    lines.push('[참석 학생]')
    if (attendees.length > 0) {
      for (const a of attendees) {
        lines.push(`- ${a.name} (${a.email})`)
      }
    } else {
      lines.push('- 참석 학생 없음')
    }
    lines.push('')

    lines.push('[다룬 주제]')
    let topics = []
    try {
      topics = session.topics_covered_json ? JSON.parse(session.topics_covered_json) : []
    } catch {
      topics = session.topics_covered_json ? [session.topics_covered_json] : []
    }
    if (topics.length > 0) {
      for (const t of topics) {
        lines.push(`- ${t}`)
      }
    } else {
      lines.push('- 내용 없음')
    }
    lines.push('')

    lines.push('[튜터 노트]')
    lines.push(session.tutor_note || '내용 없음')
    lines.push('')

    lines.push('[학생 이해도]')
    if (understandings.length > 0) {
      // 학생별로 그룹핑
      const byStudent = {}
      for (const u of understandings) {
        if (!byStudent[u.student_name]) byStudent[u.student_name] = []
        byStudent[u.student_name].push(u)
      }
      for (const [studentName, items] of Object.entries(byStudent)) {
        lines.push(`${studentName}:`)
        for (const item of items) {
          lines.push(`  - ${item.topic}: ${levelToKorean(item.level)}`)
        }
      }
    } else {
      lines.push('- 이해도 데이터 없음')
    }
    lines.push('')

    lines.push('[퀴즈 결과]')
    if (quizResults.length > 0) {
      for (const r of quizResults) {
        const total = parseInt(r.total)
        const correct = parseInt(r.correct)
        const pct = total > 0 ? Math.round((correct / total) * 100) : 0
        lines.push(`- ${r.name}: ${correct}/${total} (${pct}%)`)
      }
    } else {
      lines.push('- 퀴즈 결과 없음')
    }
    lines.push('')

    lines.push(`생성일시: ${new Date().toISOString()}`)
    lines.push('===================================')

    const reportText = lines.join('\n')
    const filename = `report_session_${session.id}_${session.date}.txt`

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(reportText)
  } catch (err) {
    next(err)
  }
})

module.exports = router
