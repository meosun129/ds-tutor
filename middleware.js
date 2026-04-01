const jwt = require('jsonwebtoken')

// JWT 검증 미들웨어 — 모든 보호된 라우트에 사용
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1] || req.query.t
  if (!token) return res.status(401).json({ error: '로그인이 필요해요' })

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: '토큰이 유효하지 않아요' })
  }
}

// tutor 전용 라우트 보호 미들웨어 — authenticateToken 이후에 사용
function requireTutor(req, res, next) {
  if (req.user?.role !== 'tutor') {
    return res.status(403).json({ error: '튜터 권한이 필요해요' })
  }
  next()
}

module.exports = { authenticateToken, requireTutor }
