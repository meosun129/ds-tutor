const { Pool } = require('pg')
require('dotenv').config()

// Railway는 DATABASE_URL 하나로 연결, 로컬은 개별 환경변수 사용
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host:     process.env.DB_HOST,
      port:     Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
    })

module.exports = pool
