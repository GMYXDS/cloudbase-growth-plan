const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 600*1000 // 单次 HTTP 请求超时 150s，生图耗时较长
})

// ====================================================================
// 开关：是否将生成的图片上传到云存储（持久保存）
//   true  → 下载并上传到云存储，返回 fileID + 云存储临时 URL（图片不会 24h 后失效）
//   false → 直接返回 cloudbase 生图的临时 URL（24h 后失效）
// 调用时也可通过 event.save_to_storage 覆盖此默认值。
// ====================================================================
const SAVE_TO_STORAGE_DEFAULT = false

const ALLOWED_SIZES = ['1024×1024', '1280×768', '768×1280', '1024×768', '768×1024', '720×1280', '1280×720']
const DEFAULT_T2I_MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0' // 文生图
const DEFAULT_I2I_MODEL = 'HY-Image-v3.0-I2I-ToB-v1.0.1'    // 图生图

/**
 * 云函数：OpenAI 兼容的图片生成接口
 *
 * 入参（OpenAI Images API 标准格式 + 扩展）：
 *   - prompt            必填，图片描述（≤500 字）
 *   - model             模型名，不传则按是否传参考图自动选择文生图/图生图模型
 *   - n                 生成数量（默认 1；cloudbase 当前仅返回 1 张）
 *   - size              尺寸，默认 '1024x1024'，可选 1280x720 / 720x1280 / 1280x1280
 *   - quality           质量（接受但 cloudbase 暂未透传）
 *   - style             风格（接受但 cloudbase 暂未透传）
 *   - response_format   返回格式 'url'（默认）| 'b64_json'
 *   - image             图生图参考图 URL（扩展参数；传了即走 I2I）
 *   - save_to_storage   是否上传云存储，默认 false
 *
 * 出参（OpenAI images 标准格式）：
 *   { created, data: [{ url | b64_json, revised_prompt }] }
 *   save_to_storage 开启时额外返回 data[].fileID
 *
 * 出错时返回 OpenAI 错误格式：
 *   { error: { message, type, code, param? } }
 */
exports.main = async (event, context) => {
  // ===== 1. 解析入参 =====
  const {
    prompt,
    model,
    n = 1,
    size = '1024x1024',
    quality,
    style,
    response_format = 'url',
    image,
    save_to_storage = SAVE_TO_STORAGE_DEFAULT
  } = event

  // ===== 2. 参数校验（OpenAI 风格错误返回）=====
  const trimmedPrompt = (prompt || '').trim()
  if (!trimmedPrompt) {
    return {
      error: {
        message: "'prompt' is required.",
        type: 'invalid_request_error',
        param: 'prompt',
        code: 'invalid_prompt'
      }
    }
  }
  if (trimmedPrompt.length > 500) {
    return {
      error: {
        message: "'prompt' must be at most 500 characters.",
        type: 'invalid_request_error',
        param: 'prompt',
        code: 'prompt_too_long'
      }
    }
  }

  const finalSize = ALLOWED_SIZES.includes(size) ? size : '1024x1024'
  const isI2I = !!image // 是否图生图
  const finalModel = model || (isI2I ? DEFAULT_I2I_MODEL : DEFAULT_T2I_MODEL)

  // ===== 3. 组装 cloudbase 生图参数 =====
  const generateOptions = {
    model: finalModel,
    prompt: trimmedPrompt,
    size: finalSize,
    revise: { value: true }
  }
  if (isI2I) {
    generateOptions.image_urls = [image]
  }

  // ===== 4. 调用 cloudbase 生图 =====
  const imageModel = cloud.ai().createImageModel('hunyuan-image')

  try {
    const res = await imageModel.generateImage(generateOptions)

    // ===== 5. 组装 OpenAI Images 响应 =====
    const created = Math.floor(Date.now() / 1000)
    const data = []

    for (const item of (res.data || [])) {
      const entry = {}
      if (item.revised_prompt) {
        entry.revised_prompt = item.revised_prompt
      }

      if (response_format === 'b64_json') {
        // b64_json 模式：下载图片转 base64，无需再上传云存储
        const buffer = await downloadBuffer(item.url)
        entry.b64_json = buffer.toString('base64')
      } else {
        // url 模式
        if (save_to_storage) {
          // 下载并上传到云存储，返回持久 fileID + 临时访问 URL
          const buffer = await downloadBuffer(item.url)
          const cloudPath = `ai-images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
          const uploadRes = await cloud.uploadFile({
            cloudPath,
            fileContent: buffer
          })
          const urlRes = await cloud.getTempFileURL({
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

    return { created, data }
  } catch (error) {
    return {
      error: {
        message: error.message || 'Internal server error',
        type: 'api_error',
        code: 'internal_error'
      }
    }
  }
}

/**
 * 下载 URL 内容为 Buffer（支持重定向）
 */
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
