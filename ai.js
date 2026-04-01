const { spawn } = require('child_process')
const https = require('https')
const db = require('./db')
require('dotenv').config()

const OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
const FALLBACK_MODEL = 'mistralai/mistral-7b-instruct:free'

// ── PDF 텍스트 추출 (Python pypdf) ───────────────────────────
async function extractPdfText(filePath) {
  return new Promise((resolve) => {
    const pythonScript = `
import sys
try:
    from pypdf import PdfReader
except ImportError:
    try:
        from PyPDF2 import PdfReader
    except ImportError:
        print('')
        sys.exit(0)

try:
    reader = PdfReader(sys.argv[1])
    text = ''
    for page in reader.pages:
        text += page.extract_text() or ''
    print(text)
except Exception as e:
    print('')
`
    const proc = spawn('python', ['-c', pythonScript, filePath])
    let output = ''
    let errOutput = ''

    proc.stdout.on('data', (chunk) => { output += chunk.toString() })
    proc.stderr.on('data', (chunk) => { errOutput += chunk.toString() })

    proc.on('close', (code) => {
      if (errOutput) {
        console.error('[ai.js] Python stderr:', errOutput.trim())
      }
      // 실패하거나 빈 결과여도 graceful degradation — 빈 문자열 반환
      resolve(output.trim())
    })

    proc.on('error', (err) => {
      console.error('[ai.js] Python spawn 오류:', err.message)
      resolve('')
    })
  })
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
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error('OpenRouter 응답 파싱 실패: ' + data.slice(0, 200)))
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
  const context = pdfText
    ? pdfText.slice(0, 3000) // 토큰 절약을 위해 앞 3000자만 사용
    : '자료구조 C언어 수업 내용 (스택, 큐, 연결 리스트, 포인터 등)'

  const prompt = `당신은 자료구조 C언어 강의 퀴즈 출제 전문가입니다.
아래 강의 내용을 바탕으로 퀴즈 3개를 JSON 배열로 생성해주세요.

강의 내용:
${context}

출제 규칙:
1. ox 타입 1개: question(문장), answer("O" 또는 "X"), explanation(해설)
2. multiple 타입 1개: question, choices_json(["①...", "②...", "③...", "④..."] 형식 JSON 문자열), answer("①"~"④" 중 하나), explanation
3. code_trace 타입 1개: question(C코드 포함 "다음 코드의 출력값은?" 형식), choices_json(["①...", "②...", "③...", "④..."] 형식 JSON 문자열), answer("①"~"④" 중 하나), explanation

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
    "choices_json": "[\"① ...\", \"② ...\", \"③ ...\", \"④ ...\"]",
    "answer": "①",
    "explanation": "..."
  },
  {
    "type": "code_trace",
    "question": "다음 코드의 출력값은?\\n[c코드]\\n...",
    "choices_json": "[\"① ...\", \"② ...\", \"③ ...\", \"④ ...\"]",
    "answer": "①",
    "explanation": "..."
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

      const choicesJson = q.choices_json
        ? (typeof q.choices_json === 'string' ? q.choices_json : JSON.stringify(q.choices_json))
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
