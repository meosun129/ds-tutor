const https = require('https')
const fs = require('fs')
const pdfParse = require('pdf-parse')
const db = require('./db')
require('dotenv').config()

const OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
const FALLBACK_MODEL = 'mistralai/mistral-7b-instruct:free'

// ── PDF 텍스트 추출 (pdf-parse, Node.js 전용) ─────────────────
async function extractPdfText(filePath) {
  try {
    const buffer = fs.readFileSync(filePath)
    const data = await pdfParse(buffer)
    const text = data.text || ''
    console.log(`[ai.js] PDF 추출 완료: ${text.length}자 (${filePath})`)
    return text.trim()
  } catch (err) {
    console.error('[ai.js] PDF 추출 오류:', err.message)
    return ''
  }
}

// ── OpenRouter API 호출 헬퍼 ─────────────────────────────────
function callOpenRouter(model, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 2048,
    })

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://ds-tutor.app',
        'X-Title': 'ds-tutor',
        'Content-Length': Buffer.byteLength(body),
      },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) console.error('[ai.js] OpenRouter 에러:', JSON.stringify(parsed.error))
          resolve(parsed)
        } catch (e) {
          reject(new Error('OpenRouter 응답 파싱 실패: ' + data.slice(0, 300)))
        }
      })
    })

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── 퀴즈 JSON 파싱 ───────────────────────────────────────────
// AI 응답에서 JSON 배열 추출 (마크다운 코드블록 등 처리)
function parseQuizJson(text) {
  // ```json ... ``` 블록 추출 시도
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = codeBlockMatch ? codeBlockMatch[1] : text

  // [ ... ] 배열 부분만 추출
  const arrayMatch = candidate.match(/\[[\s\S]*\]/)
  if (!arrayMatch) throw new Error('JSON 배열을 찾을 수 없어요')

  return JSON.parse(arrayMatch[0])
}

// ── 퀴즈 생성 및 DB 저장 ─────────────────────────────────────
async function generateQuizzes(weekId, pdfText) {
  // PDF 텍스트 추출 결과 로그
  console.log(`[ai.js] PDF 텍스트 길이: ${(pdfText || '').length}자 (weekId=${weekId})`)
  if (!pdfText || pdfText.trim().length < 50) {
    console.warn(`[ai.js] PDF 텍스트가 너무 짧거나 비어있어 퀴즈 생성을 건너뜁니다 (weekId=${weekId})`)
    return []
  }

  // 기존 퀴즈 조회 — 중복 방지용
  const { rows: existingQuizzes } = await db.query(
    'SELECT question FROM quizzes WHERE week_id = $1',
    [weekId]
  )

  // 기존 퀴즈 수에 따라 PDF 다른 구간 사용 (다양성 확보)
  const chunkSize = 3000
  const offset = existingQuizzes.length > 0
    ? Math.min(existingQuizzes.length * 800, Math.max(0, pdfText.length - chunkSize))
    : 0
  const context = pdfText.slice(offset, offset + chunkSize)
  console.log(`[ai.js] 사용 구간: ${offset}~${offset + chunkSize}자`)

  const existingBlock = existingQuizzes.length > 0
    ? `\n【이미 출제된 문제 — 유사한 문제는 절대 출제 금지】\n${existingQuizzes.map((q, i) => `${i + 1}. ${q.question.slice(0, 120)}`).join('\n')}\n`
    : ''

  const prompt = `당신은 자료구조 C언어 강의 퀴즈 출제 전문가입니다.
반드시 아래 【강의 내용】에 등장하는 개념, 용어, 예제만을 사용하여 퀴즈를 출제하세요.
강의 내용에 없는 내용은 절대 출제하지 마세요.
${existingBlock}
【강의 내용】:
${context}

출제 규칙:
1. ox 타입 1개: question(문장), answer("O" 또는 "X"), explanation(해설), choices는 null
2. multiple 타입 1개: question, choices(["① ...", "② ...", "③ ...", "④ ..."] 배열), answer("①"~"④" 중 하나), explanation
3. code_trace 타입 1개 (중요 — 아래 지침 준수):
   - 변수 2~4개, printf 1회만 사용하는 매우 간단한 C 코드를 직접 작성하세요
   - 코드를 한 줄씩 실행하며 변수 값을 단계적으로 추적한 뒤 최종 출력값을 확정하세요
   - answer는 추적 결과와 정확히 일치하는 선택지여야 합니다
   - choices의 오답 3개는 흔한 실수 결과값으로 구성하세요
   - explanation에 단계별 추적 과정을 포함하세요
   - choices는 ["① ...", "② ...", "③ ...", "④ ..."] 배열 형식

반드시 아래 JSON 배열 형식으로만 응답하세요 (다른 텍스트 없이):
[
  {
    "type": "ox",
    "question": "...",
    "choices_json": null,
    "answer": "O",
    "explanation": "..."
  },
  {
    "type": "multiple",
    "question": "...",
    "choices": ["① ...", "② ...", "③ ...", "④ ..."],
    "answer": "①",
    "explanation": "..."
  },
  {
    "type": "code_trace",
    "question": "다음 코드의 출력값은?\\n\\n[C코드]\\n...",
    "choices": ["① ...", "② ...", "③ ...", "④ ..."],
    "answer": "①",
    "explanation": "단계별 추적: ..."
  }
]`

  const messages = [{ role: 'user', content: prompt }]

  let rawContent = null

  // 1차 시도: 메인 모델
  try {
    const result = await callOpenRouter(OPENROUTER_MODEL, messages)
    rawContent = result?.choices?.[0]?.message?.content
    if (!rawContent) throw new Error('응답 content 없음')
  } catch (err) {
    console.warn(`[ai.js] 메인 모델(${OPENROUTER_MODEL}) 실패:`, err.message)
    // 2차 시도: fallback 모델
    try {
      const result = await callOpenRouter(FALLBACK_MODEL, messages)
      rawContent = result?.choices?.[0]?.message?.content
      if (!rawContent) throw new Error('fallback 응답 content 없음')
    } catch (fallbackErr) {
      console.error('[ai.js] Fallback 모델도 실패:', fallbackErr.message)
      return []
    }
  }

  // JSON 파싱
  let quizzes
  try {
    quizzes = parseQuizJson(rawContent)
  } catch (parseErr) {
    console.error('[ai.js] 퀴즈 JSON 파싱 실패:', parseErr.message)
    console.error('[ai.js] 원본 응답:', rawContent.slice(0, 500))
    return []
  }

  if (!Array.isArray(quizzes) || quizzes.length === 0) {
    console.error('[ai.js] 퀴즈 배열이 비어있거나 형식 오류')
    return []
  }

  // DB 저장
  const saved = []
  for (const q of quizzes) {
    try {
      const validTypes = ['ox', 'multiple', 'code_trace']
      if (!validTypes.includes(q.type)) {
        console.warn('[ai.js] 유효하지 않은 퀴즈 타입, 건너뜀:', q.type)
        continue
      }

      // AI가 choices(배열) 또는 choices_json(문자열/배열) 형태로 줄 수 있음
      const rawChoices = q.choices || q.choices_json || null
      const choicesJson = rawChoices
        ? (typeof rawChoices === 'string' ? rawChoices : JSON.stringify(rawChoices))
        : null

      const { rows } = await db.query(
        `INSERT INTO quizzes (week_id, type, question, choices_json, answer, explanation, approved)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         RETURNING *`,
        [weekId, q.type, q.question, choicesJson, q.answer, q.explanation || null]
      )
      saved.push(rows[0])
    } catch (dbErr) {
      console.error('[ai.js] 퀴즈 DB 저장 실패:', dbErr.message)
    }
  }

  console.log(`[ai.js] ${saved.length}개 퀴즈 생성 완료 (weekId=${weekId})`)
  return saved
}

module.exports = { extractPdfText, generateQuizzes }
