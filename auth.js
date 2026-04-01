const express = require('express')
const bcrypt  = require('bcrypt')
const jwt     = require('jsonwebtoken')
const db      = require('./db')

const router = express.Router()

// POST /auth/register
// body: { email, password, name, role }
// role이 'tutor'인 계정은 최대 1개만 허용
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body

    // 필수 필드 검증
    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: '이메일, 비밀번호, 이름, 역할을 모두 입력해주세요' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '올바른 이메일 형식이 아니에요' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '비밀번호는 6자 이상이어야 해요' })
    }
    if (!['tutor', 'student'].includes(role)) {
      return res.status(400).json({ error: 'role은 tutor 또는 student여야 해요' })
    }

    // tutor는 1명만 허용
    if (role === 'tutor') {
      const tutorCheck = await db.query(
        "SELECT id FROM users WHERE role = 'tutor' LIMIT 1"
      )
      if (tutorCheck.rows.length > 0) {
        return res.status(400).json({ error: '튜터 계정은 이미 존재해요' })
      }
    }

    // 이메일 중복 확인
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email])
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: '이미 사용 중인 이메일이에요' })
    }

    const hashed = await bcrypt.hash(password, 10)
    const { rows } = await db.query(
      'INSERT INTO users (email, password, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role',
      [email, hashed, name, role]
    )
    const user = rows[0]

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  } catch (err) {
    console.error('[register]', err)
    res.status(500).json({ error: '서버 오류가 발생했어요' })
  }
})

// POST /auth/login
// body: { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' })
    }

    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email])
    if (rows.length === 0) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 틀렸어요' })
    }

    const user = rows[0]
    const match = await bcrypt.compare(password, user.password)
    if (!match) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 틀렸어요' })
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  } catch (err) {
    console.error('[login]', err)
    res.status(500).json({ error: '서버 오류가 발생했어요' })
  }
})

module.exports = router
