const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 600*1000
})

/**
 * 云函数：OpenAI 兼容的文本补全接口
 *
 * 入参（OpenAI Chat Completions 标准格式）：
 *   - model              模型名，默认 'hy3'
 *   - messages           消息数组，[{role, content}]
 *   - temperature        采样温度
 *   - max_tokens         最大生成 token 数
 *   - top_p              nucleus 采样
 *   - frequency_penalty  频率惩罚
 *   - presence_penalty   存在惩罚
 *   - stop               停止词（string 或 string[]）
 *   - stream             是否流式（本云函数暂仅支持非流式，传 true 会被忽略并按非流式返回）
 *
 * 出参（OpenAI chat.completion 标准格式）：
 *   { id, object, created, model, choices:[{index, message:{role, content, reasoning_content?}, finish_reason}], usage }
 *
 * 出错时返回 OpenAI 错误格式：
 *   { error: { message, type, code } }
 */
exports.main = async (event, context) => {
  // ===== 1. 解析 OpenAI 标准入参 =====
  const {
    model = 'hy3',
    messages,
    temperature,
    max_tokens,
    top_p,
    frequency_penalty,
    presence_penalty,
    stop,
    stream = false
  } = event

  // ===== 2. 参数校验（OpenAI 风格错误返回）=====
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return {
      error: {
        message: "'messages' is required and must be a non-empty array.",
        type: 'invalid_request_error',
        param: 'messages',
        code: 'invalid_messages'
      }
    }
  }

  // ===== 3. 组装 cloudbase 调用参数（仅传有值的字段）=====
  const generateOptions = { model, messages }
  if (temperature !== undefined) generateOptions.temperature = temperature
  if (max_tokens !== undefined) generateOptions.max_tokens = max_tokens
  if (top_p !== undefined) generateOptions.top_p = top_p
  if (frequency_penalty !== undefined) generateOptions.frequency_penalty = frequency_penalty
  if (presence_penalty !== undefined) generateOptions.presence_penalty = presence_penalty
  if (stop !== undefined) generateOptions.stop = stop

  // ===== 4. 调用 cloudbase 大模型 =====
  const ai = cloud.ai()
  const cbModel = ai.createModel('cloudbase')

  try {
    const result = await cbModel.generateText(generateOptions)

    // ===== 5. 优先透传 cloudbase 已有的 OpenAI 结构（rawResponses）=====
    const raw = (result.rawResponses && result.rawResponses[0]) || {}
    const id = raw.id || `chatcmpl-${Date.now()}`
    const created = raw.created || Math.floor(Date.now() / 1000)

    let choices
    if (raw.choices && raw.choices.length > 0) {
      choices = raw.choices.map((c, i) => {
        const msg = c.message || {}
        const message = { role: msg.role || 'assistant', content: msg.content || result.text || '' }
        // 部分模型会返回 reasoning_content（思维链），有则保留
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
      // 兜底：直接用 result.text 构造
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

    // ===== 6. 返回标准 OpenAI chat.completion 对象 =====
    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices,
      usage
    }
  } catch (error) {
    // ===== 7. 错误按 OpenAI 格式返回 =====
    return {
      error: {
        message: error.message || 'Internal server error',
        type: 'api_error',
        code: 'internal_error'
      }
    }
  }
}
