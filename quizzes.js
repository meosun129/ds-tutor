const express = require('express')
const db = require('./db')
const { authenticateToken, requireTutor } = require('./middleware')

const router = express.Router()

// ── 헬퍼 ────────────────────────────────────────────────────
async function getQuizById(id) {
  const { rows } = await db.query('SELECT * FROM quizzes WHERE id = $1', [id])
  return rows[0] || null
}

function requireStudent(req, res, next) {
  if (req.user?.role !== 'student') {
    return res.status(403).json({ error: '학생만 답안을 제출할 수 있어요' })
  }
  next()
}

// ── 라우트 ──────────────────────────────────────────────────

// GET /quizzes/my-results — 내 퀴즈 풀이 기록 (student 전용)
router.get('/my-results', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT qr.id, qr.quiz_id, qr.user_answer, qr.is_correct, qr.submitted_at,
              q.type, q.question, q.answer, q.explanation, q.week_id
       FROM quiz_results qr
       JOIN quizzes q ON q.id = qr.quiz_id
       WHERE qr.user_id = $1
       ORDER BY qr.submitted_at DESC`,
      [req.user.id]
    )
    res.json({ data: rows })
  } catch (err) {
    next(err)
  }
})

// GET /quizzes?week_id=&approved= — 퀴즈 목록 조회 (인증 필요)
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { week_id, approved } = req.query
    const conditions = []
    const params = []

    if (week_id) {
      params.push(parseInt(week_id))
      conditions.push(`week_id = $${params.length}`)
    }

    if (approved !== undefined) {
      params.push(approved === 'true')
      conditions.push(`approved = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const { rows } = await db.query(
      `SELECT * FROM quizzes ${where} ORDER BY created_at ASC`,
      params
    )
    res.json({ data: rows })
  } catch (err) {
    next(err)
  }
})

// GET /quizzes/:id — 퀴즈 상세 조회 (인증 필요)
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const quiz = await getQuizById(req.params.id)
    if (!quiz) return res.status(404).json({ error: '퀴즈를 찾을 수 없어요' })
    res.json({ data: quiz })
  } catch (err) {
    next(err)
  }
})

// POST /quizzes — 퀴즈 수동 생성 (tutor 전용)
router.post('/', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const { week_id, type, question, choices_json, answer, explanation } = req.body

    if (!week_id || !type || !question || !answer) {
      return res.status(400).json({ error: '주차 ID, 유형, 질문, 정답은 필수예요' })
    }

    const validTypes = ['ox', 'multiple', 'code_trace']
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: '퀴즈 유형은 ox, multiple, code_trace 중 하나여야 해요' })
    }

    // week 존재 여부 확인
    const { rows: weekRows } = await db.query('SELECT id FROM weeks WHERE id = $1', [week_id])
    if (weekRows.length === 0) {
      return res.status(404).json({ error: '해당 주차를 찾을 수 없어요' })
    }

    const choicesJson = choices_json
      ? (typeof choices_json === 'string' ? choices_json : JSON.stringify(choices_json))
      : null

    const { rows } = await db.query(
      `INSERT INTO quizzes (week_id, type, question, choices_json, answer, explanation, approved)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING *`,
      [week_id, type, question, choicesJson, answer, explanation || null]
    )
    res.status(201).json({ data: rows[0] })
  } catch (err) {
    next(err)
  }
})

// PUT /quizzes/:id — 퀴즈 수정 (tutor 전용)
router.put('/:id', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const quiz = await getQuizById(req.params.id)
    if (!quiz) return res.status(404).json({ error: '퀴즈를 찾을 수 없어요' })

    const { type, question, choices_json, answer, explanation } = req.body

    if (type) {
      const validTypes = ['ox', 'multiple', 'code_trace']
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: '퀴즈 유형은 ox, multiple, code_trace 중 하나여야 해요' })
      }
    }

    const newType = type || quiz.type
    const newQuestion = question || quiz.question
    const newAnswer = answer || quiz.answer
    const newExplanation = explanation !== undefined ? explanation : quiz.explanation

    let newChoicesJson = quiz.choices_json
    if (choices_json !== undefined) {
      newChoicesJson = choices_json
        ? (typeof choices_json === 'string' ? choices_json : JSON.stringify(choices_json))
        : null
    }

    const { rows } = await db.query(
      `UPDATE quizzes
       SET type = $1, question = $2, choices_json = $3, answer = $4, explanation = $5
       WHERE id = $6
       RETURNING *`,
      [newType, newQuestion, newChoicesJson, newAnswer, newExplanation, req.params.id]
    )
    res.json({ data: rows[0] })
  } catch (err) {
    next(err)
  }
})

// DELETE /quizzes/:id — 퀴즈 삭제 (tutor 전용)
router.delete('/:id', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const quiz = await getQuizById(req.params.id)
    if (!quiz) return res.status(404).json({ error: '퀴즈를 찾을 수 없어요' })

    await db.query('DELETE FROM quizzes WHERE id = $1', [req.params.id])
    res.json({ data: { message: '퀴즈가 삭제됐어요' } })
  } catch (err) {
    next(err)
  }
})

// POST /quizzes/:id/approve — 퀴즈 승인 (tutor 전용)
router.post('/:id/approve', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const quiz = await getQuizById(req.params.id)
    if (!quiz) return res.status(404).json({ error: '퀴즈를 찾을 수 없어요' })

    const { rows } = await db.query(
      'UPDATE quizzes SET approved = true WHERE id = $1 RETURNING *',
      [req.params.id]
    )
    res.json({ data: rows[0] })
  } catch (err) {
    next(err)
  }
})

// POST /quizzes/:id/reject — 퀴즈 거절 및 삭제 (tutor 전용)
router.post('/:id/reject', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const quiz = await getQuizById(req.params.id)
    if (!quiz) return res.status(404).json({ error: '퀴즈를 찾을 수 없어요' })

    await db.query('DELETE FROM quizzes WHERE id = $1', [req.params.id])
    res.json({ data: { message: '퀴즈가 거절 및 삭제됐어요' } })
  } catch (err) {
    next(err)
  }
})

// POST /quizzes/:id/submit — 학생 답안 제출 (student 전용)
router.post('/:id/submit', authenticateToken, requireStudent, async (req, res, next) => {
  try {
    const quiz = await getQuizById(req.params.id)
    if (!quiz) return res.status(404).json({ error: '퀴즈를 찾을 수 없어요' })

    if (!quiz.approved) {
      return res.status(403).json({ error: '아직 공개되지 않은 퀴즈예요' })
    }

    const { user_answer } = req.body
    if (!user_answer) {
      return res.status(400).json({ error: '답안을 입력해주세요' })
    }

    // 정답 비교 (대소문자 무시, 앞뒤 공백 제거)
    const isCorrect = quiz.answer.trim().toLowerCase() === user_answer.trim().toLowerCase()

    const { rows } = await db.query(
      `INSERT INTO quiz_results (user_id, quiz_id, user_answer, is_correct)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.id, quiz.id, user_answer, isCorrect]
    )

    res.status(201).json({
      data: {
        ...rows[0],
        is_correct: isCorrect,
        correct_answer: isCorrect ? null : quiz.answer, // 틀렸을 때만 정답 공개
        explanation: quiz.explanation,
      },
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
