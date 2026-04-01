const express = require('express')
const path = require('path')
const fs = require('fs')
const multer = require('multer')
const db = require('./db')
const { authenticateToken, requireTutor } = require('./middleware')
const { extractPdfText, generateQuizzes } = require('./ai')

const router = express.Router()

// ── multer 설정 ──────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads')

// uploads/ 디렉토리가 없으면 생성
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const timestamp = Date.now()
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `week_${timestamp}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.pdf') {
      return cb(new Error('PDF 파일만 업로드할 수 있어요'))
    }
    cb(null, true)
  },
})

// ── 헬퍼 ────────────────────────────────────────────────────
async function getWeekById(id) {
  const { rows } = await db.query('SELECT * FROM weeks WHERE id = $1', [id])
  return rows[0] || null
}

// ── 라우트 ──────────────────────────────────────────────────

// GET /weeks — 주차 목록 전체 조회 (인증 필요)
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, week_no, title, pdf_text, created_at FROM weeks ORDER BY week_no ASC'
    )
    res.json({ data: rows })
  } catch (err) {
    next(err)
  }
})

// POST /weeks — 주차 생성 (tutor 전용)
router.post('/', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const { week_no, title } = req.body

    if (!week_no || !title) {
      return res.status(400).json({ error: '주차 번호와 제목을 입력해주세요' })
    }

    if (typeof week_no !== 'number' && isNaN(parseInt(week_no))) {
      return res.status(400).json({ error: '주차 번호는 숫자여야 해요' })
    }

    const { rows } = await db.query(
      'INSERT INTO weeks (week_no, title) VALUES ($1, $2) RETURNING *',
      [parseInt(week_no), title.trim()]
    )
    res.status(201).json({ data: rows[0] })
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json({ error: '이미 존재하는 주차 번호예요' })
    }
    next(err)
  }
})

// GET /weeks/:id — 주차 상세 조회 (인증 필요)
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const week = await getWeekById(req.params.id)
    if (!week) return res.status(404).json({ error: '주차를 찾을 수 없어요' })
    res.json({ data: week })
  } catch (err) {
    next(err)
  }
})

// PUT /weeks/:id — 주차 정보 수정 (tutor 전용)
router.put('/:id', authenticateToken, requireTutor, async (req, res, next) => {
  try {
    const week = await getWeekById(req.params.id)
    if (!week) return res.status(404).json({ error: '주차를 찾을 수 없어요' })

    const { week_no, title } = req.body
    const newWeekNo = week_no !== undefined ? parseInt(week_no) : week.week_no
    const newTitle = title !== undefined ? title.trim() : week.title

    if (!newTitle) {
      return res.status(400).json({ error: '제목을 입력해주세요' })
    }

    const { rows } = await db.query(
      'UPDATE weeks SET week_no = $1, title = $2 WHERE id = $3 RETURNING *',
      [newWeekNo, newTitle, req.params.id]
    )
    res.json({ data: rows[0] })
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: '이미 존재하는 주차 번호예요' })
    }
    next(err)
  }
})

// POST /weeks/:id/upload-pdf — PDF 업로드 및 AI 퀴즈 자동생성 (tutor 전용)
router.post(
  '/:id/upload-pdf',
  authenticateToken,
  requireTutor,
  (req, res, next) => {
    upload.single('pdf')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'PDF 파일 크기는 10MB 이하여야 해요' })
        }
        return res.status(400).json({ error: '파일 업로드 오류: ' + err.message })
      }
      if (err) {
        return res.status(400).json({ error: err.message })
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'PDF 파일을 첨부해주세요' })
      }

      const week = await getWeekById(req.params.id)
      if (!week) {
        // 업로드된 파일 정리
        fs.unlink(req.file.path, () => {})
        return res.status(404).json({ error: '주차를 찾을 수 없어요' })
      }

      const filePath = req.file.path

      // PDF 텍스트 추출 (Python 실패 시 빈 문자열 반환)
      const pdfText = await extractPdfText(filePath)

      // weeks 테이블 pdf_text 업데이트
      await db.query(
        'UPDATE weeks SET pdf_text = $1 WHERE id = $2',
        [pdfText, week.id]
      )

      // AI 퀴즈 자동생성 (백그라운드 시작 — 응답은 즉시 반환)
      res.status(202).json({
        data: {
          message: 'PDF 업로드 완료. 퀴즈 생성을 시작했어요.',
          week_id: week.id,
          filename: req.file.filename,
          pdf_text_length: pdfText.length,
        },
      })

      // 응답 후 비동기로 퀴즈 생성
      generateQuizzes(week.id, pdfText).catch((err) => {
        console.error('[POST /weeks/:id/upload-pdf] 퀴즈 생성 오류:', err.message)
      })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
