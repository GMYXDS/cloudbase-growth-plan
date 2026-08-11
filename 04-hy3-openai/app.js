const express = require('express')
const tcb = require('@cloudbase/node-sdk')
const https = require('https')
const crypto = require('crypto')

// ====================================================================
// 初始化 CloudBase Node SDK
// 云托管环境中会自动注入临时密钥，只需指定 env。
// 需在云托管控制台 → 服务设置 → 环境变量中配置 ENV_ID。
// ====================================================================
const tcbApp = tcb.init({
  env: process.env.ENV_ID || '',
  secretId: process.env.ENV_SECRETID || '',
  secretKey: process.env.ENV_SECRETKEY || '',
  timeout: 600*1000
})

const ai = tcbApp.ai()

// ====================================================================
// 常量
// ====================================================================
const DEFAULT_T2I_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0'
const DEFAULT_I2I_MODEL = 'HY-Image-v3.0-I2I-ToB-v1.0.1'
const ALLOWED_SIZES = ['1024×1024', '1280×768', '768×1280', '1024×768', '768×1024', '720×1280', '1280×720']

// 云存储开关：是否将生成的图片上传到云存储（持久保存）
//   true  → 上传云存储，返回 fileID + 云存储临时 URL
//   false → 直接返回 cloudbase 临时 URL（24h 后失效）
// 也可通过请求体 save_to_storage 覆盖
const SAVE_TO_STORAGE_DEFAULT = false

// ====================================================================
// API Key 鉴权（固定写在代码里，后续可改为环境变量）
// 客户端通过 Authorization: Bearer <key> 或 api-key 头部传递
// ====================================================================
const API_KEY = process.env.API_KEY || 'sk-hy3-cloudbase-openai' // ← 改成你自己的 key

// ====================================================================
// 可用模型列表（对齐 OpenAI GET /v1/models 返回格式）
// ====================================================================
const MODEL_CREATED = 1700000000 // 固定时间戳
const MODELS = [
  {
    id: 'hy3',
    object: 'model',
    created: MODEL_CREATED,
    owned_by: 'cloudbase',
    type: 'text',
    description: '混元 hy3 文本生成模型'
  },
  {
    id: 'hy3-preview',
    object: 'model',
    created: MODEL_CREATED,
    owned_by: 'cloudbase',
    type: 'text',
    description: '混元 hy3 预览版文本生成模型'
  },
  {
    id: 'HY-Image-3.0-Plus-4090-Tob-v1.0',
    object: 'model',
    created: MODEL_CREATED,
    owned_by: 'cloudbase',
    type: 'image',
    description: '混元生图模型（文生图 T2I）'
  },
  {
    id: 'HY-Image-v3.0-I2I-ToB-v1.0.1',
    object: 'model',
    created: MODEL_CREATED,
    owned_by: 'cloudbase',
    type: 'image',
    description: '混元图生图模型（I2I）'
  }
]

// ====================================================================
// Express 应用
// ====================================================================
const app = express()
app.use(express.json({ limit: '10mb' }))

// --------------------------------------------------------------------
// 工具函数
// --------------------------------------------------------------------

/** 生成 OpenAI 风格 id */
function genId(prefix = 'chatcmpl') {
  return `${prefix}-${crypto.randomBytes(12).toString('hex')}`
}

/** 返回 OpenAI 风格错误 */
function sendError(res, status, message, type = 'api_error', code = null, param = null) {
  const error = { message, type }
  if (code) error.code = code
  if (param) error.param = param
  return res.status(status).json({ error })
}

/** 下载 URL 内容为 Buffer（支持重定向） */
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          downloadBuffer(response.headers.location).then(resolve).catch(reject)
          return
        }
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve(Buffer.concat(chunks)))
        response.on('error', reject)
      })
      .on('error', reject)
  })
}

// --------------------------------------------------------------------
// API Key 鉴权中间件
// 支持 Authorization: Bearer <key> 和 api-key 两种头部传递方式
// /health 和 / 根路由不需要鉴权
// --------------------------------------------------------------------
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  const apiKeyHeader = req.headers['api-key']

  let token = null
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else if (apiKeyHeader) {
    token = apiKeyHeader
  }

  if (!token || token !== API_KEY) {
    return sendError(
      res, 401,
      "Incorrect API key provided. Check that you're using a valid API key.",
      'invalid_request_error', 'invalid_api_key'
    )
  }

  next()
}

// ====================================================================
// 路由：GET /v1/models
// 返回所有可用模型列表（OpenAI 标准格式）
// ====================================================================
app.get('/v1/models', authMiddleware, (req, res) => {
  res.json({
    object: 'list',
    data: MODELS
  })
})

// ====================================================================
// 路由：GET /v1/models/:modelId
// 返回单个模型详情
// ====================================================================
app.get('/v1/models/:modelId', authMiddleware, (req, res) => {
  const model = MODELS.find((m) => m.id === req.params.modelId)
  if (!model) {
    return sendError(
      res, 404,
      `The model '${req.params.modelId}' does not exist.`,
      'invalid_request_error', 'model_not_found'
    )
  }
  res.json(model)
})

// ====================================================================
// 路由：POST /v1/chat/completions
// 支持非流式（stream:false）和流式 SSE（stream:true）
// ====================================================================
app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
  const {
    model = 'hy3',
    messages,
    temperature,
    max_tokens,
    top_p,
    frequency_penalty,
    presence_penalty,
    stop,
    stream = false,
    stream_options
  } = req.body

  // 参数校验
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return sendError(
      res, 400,
      "'messages' is required and must be a non-empty array.",
      'invalid_request_error', 'invalid_messages', 'messages'
    )
  }

  // 组装 cloudbase 调用参数（仅传有值的字段）
  const generateOptions = { model, messages }
  if (temperature !== undefined) generateOptions.temperature = temperature
  if (max_tokens !== undefined) generateOptions.max_tokens = max_tokens
  if (top_p !== undefined) generateOptions.top_p = top_p
  if (frequency_penalty !== undefined) generateOptions.frequency_penalty = frequency_penalty
  if (presence_penalty !== undefined) generateOptions.presence_penalty = presence_penalty
  if (stop !== undefined) generateOptions.stop = stop

  const cbModel = ai.createModel('cloudbase')
  const includeUsage = stream_options && stream_options.include_usage === true

  try {
    if (stream) {
      // ================================================================
      // 流式 SSE 响应
      // ================================================================
      const completionId = genId()
      const created = Math.floor(Date.now() / 1000)

      // SSE 响应头
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no') // 禁用 nginx 缓冲，保证实时推送
      res.flushHeaders()

      // 客户端断开标志
      // 必须用 res.on('close') 而不是 req.on('close')
      // req.on('close') 在请求体接收完毕后就会触发（POST 请求一解析完 body 就触发），
      // 不代表客户端断开，会导致 clientClosed 误判为 true、降级逻辑被跳过
      // res.on('close') 才在客户端真正断开连接时触发
      let clientClosed = false
      res.on('close', () => {
        clientClosed = true
      })

      /** 发送一个 SSE chunk */
      const sendChunk = (delta, finishReason = null, usage = null) => {
        if (clientClosed) return
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finishReason
            }
          ]
        }
        if (usage) chunk.usage = usage
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }

      // 1. 发送首个 chunk（携带 role）
      sendChunk({ role: 'assistant', content: '' })

      // 2. 调用 cloudbase 流式接口
      const streamOptions = { model, messages }
      if (temperature !== undefined) streamOptions.temperature = temperature
      if (top_p !== undefined) streamOptions.top_p = top_p

      let hasContent = false
      let streamUsage = null

      // streamText 单独 try-catch，失败不影响降级逻辑
      try {
        const streamRes = await cbModel.streamText(streamOptions)

        // 迭代 textStream，逐段推送
        for await (const text of streamRes.textStream) {
          if (clientClosed) break
          if (text) {
            hasContent = true
            sendChunk({ content: text })
          }
        }

        // 获取 usage
        if (includeUsage && hasContent && streamRes.usage) {
          try {
            streamUsage = await streamRes.usage
          } catch (_) {
            streamUsage = null
          }
        }
      } catch (streamErr) {
        console.error('[stream] streamText error:', streamErr.message)
      }

      // 降级：textStream 为空或失败时，用 generateText 一次性获取
      if (!hasContent && !clientClosed) {
        try {
          const result = await cbModel.generateText(streamOptions)
          if (result.text) {
            sendChunk({ content: result.text })
          }
          if (includeUsage) {
            streamUsage = result.usage || null
          }
        } catch (_) {
          // 降级也失败，跳过
        }
      }

      // 3. 发送结束 chunk
      if (!clientClosed) {
        sendChunk({}, 'stop', includeUsage ? streamUsage : null)
        res.write('data: [DONE]\n\n')
        res.end()
      }
    } else {
      // ================================================================
      // 非流式响应
      // ================================================================
      const result = await cbModel.generateText(generateOptions)

      // 优先透传 cloudbase 已有的 OpenAI 结构（rawResponses）
      const raw = (result.rawResponses && result.rawResponses[0]) || {}
      const id = raw.id || genId()
      const created = raw.created || Math.floor(Date.now() / 1000)

      let choices
      if (raw.choices && raw.choices.length > 0) {
        choices = raw.choices.map((c, i) => {
          const msg = c.message || {}
          const message = {
            role: msg.role || 'assistant',
            content: msg.content || result.text || ''
          }
          if (msg.reasoning_content !== undefined && msg.reasoning_content !== '') {
            message.reasoning_content = msg.reasoning_content
          }
          return {
            index: typeof c.index === 'number' ? c.index : i,
            message,
            finish_reason: c.finish_reason || 'stop'
          }
        })
      } else {
        choices = [
          {
            index: 0,
            message: { role: 'assistant', content: result.text || '' },
            finish_reason: 'stop'
          }
        ]
      }

      const usage = result.usage || raw.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }

      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices,
        usage
      })
    }
  } catch (error) {
    if (stream && res.headersSent) {
      // 流式模式下已发送头部，只能通过 SSE 结束
      try {
        res.write('data: [DONE]\n\n')
        res.end()
      } catch (_) {
        // 连接可能已断开
      }
    } else {
      sendError(res, 500, error.message || 'Internal server error', 'api_error', 'internal_error')
    }
  }
})

// ====================================================================
// 路由：POST /v1/images/generations
// 支持文生图（T2I）和图生图（I2I）
// ====================================================================
app.post('/v1/images/generations', authMiddleware, async (req, res) => {
  const {
    prompt,
    model,
    n = 1,
    size = '1024x1024',
    response_format = 'url',
    image,
    save_to_storage = SAVE_TO_STORAGE_DEFAULT,
    seed,
    revise,
    enable_thinking
  } = req.body

  // 参数校验
  const trimmedPrompt = (prompt || '').trim()
  if (!trimmedPrompt) {
    return sendError(
      res, 400,
      "'prompt' is required.",
      'invalid_request_error', 'invalid_prompt', 'prompt'
    )
  }

  const finalSize = ALLOWED_SIZES.includes(size) ? size : '1024x1024'
  const isI2I = !!image
  const finalModel = model || (isI2I ? DEFAULT_I2I_MODEL : DEFAULT_T2I_MODEL)

  // 组装 cloudbase 生图参数
  const generateOptions = {
    model: finalModel,
    prompt: trimmedPrompt,
    size: finalSize,
    revise: revise !== undefined ? revise : { value: true }
  }
  if (isI2I) {
    generateOptions.image_urls = [image]
  }
  if (seed !== undefined) generateOptions.seed = seed
  if (enable_thinking !== undefined) generateOptions.enable_thinking = enable_thinking

  const imageModel = ai.createImageModel('hunyuan-image')

  try {
    const result = await imageModel.generateImage(generateOptions)
    const created = result.created || Math.floor(Date.now() / 1000)
    const data = []

    for (const item of (result.data || [])) {
      const entry = {}
      if (item.revised_prompt) {
        entry.revised_prompt = item.revised_prompt
      }

      if (response_format === 'b64_json') {
        // b64_json 模式：下载图片转 base64
        const buffer = await downloadBuffer(item.url)
        entry.b64_json = buffer.toString('base64')
      } else {
        // url 模式
        if (save_to_storage) {
          // 下载并上传到云存储，返回持久 fileID + 临时访问 URL
          const buffer = await downloadBuffer(item.url)
          const cloudPath = `ai-images/${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`
          const uploadRes = await tcbApp.uploadFile({
            cloudPath,
            fileContent: buffer
          })
          const urlRes = await tcbApp.getTempFileURL({
            fileList: [uploadRes.fileID]
          })
          entry.url = (urlRes.fileList[0] && urlRes.fileList[0].tempFileURL) || item.url
          entry.fileID = uploadRes.fileID
        } else {
          entry.url = item.url
        }
      }

      data.push(entry)
    }

    res.json({ created, data })
  } catch (error) {
    sendError(res, 500, error.message || 'Internal server error', 'api_error', 'internal_error')
  }
})

// ====================================================================
// 健康检查 & 根路由
// ====================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Math.floor(Date.now() / 1000) })
})

app.get('/', (req, res) => {
  res.json({
    name: 'hy3-openai-server',
    version: '1.0.0',
    description: 'CloudBase 云托管：OpenAI 兼容的混元大模型 HTTP 服务',
    endpoints: {
      'GET /v1/models': '获取所有可用模型',
      'GET /v1/models/:id': '获取单个模型详情',
      'POST /v1/chat/completions': '文本生成（支持 stream SSE 流式）',
      'POST /v1/images/generations': '图片生成（文生图 / 图生图）',
      'GET /health': '健康检查（无需鉴权）'
    }
  })
})

// ====================================================================
// 全局错误处理
// ====================================================================
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'Invalid JSON in request body.', 'invalid_request_error', 'invalid_json')
  }
  sendError(res, 500, err.message || 'Internal server error', 'api_error', 'internal_error')
})

// ====================================================================
// 启动服务
// ====================================================================
const PORT = process.env.PORT || 80
app.listen(PORT, () => {
  console.log(`[hy3-openai-server] listening on :${PORT}`)
})

module.exports = app
