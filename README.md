# cloudbase-growth-plan

小程序成长计划 —— 基于腾讯云 CloudBase 的 AI 能力封装项目。

本项目将腾讯云 CloudBase 提供的混元大模型（文本生成 / 图片生成）封装为 **OpenAI 兼容** 的接口，方便已有 OpenAI 客户端代码的同学零成本迁移。

## 目录结构

```
.
├── 01-text-completion/      # 云函数：OpenAI 兼容的文本补全接口（非流式）
├── 03-image-generation/     # 云函数：OpenAI 兼容的图片生成接口（文生图 / 图生图）
├── 04-hy3-openai/           # 云托管：完整的 OpenAI 兼容 HTTP 服务（文本/流式/图片）
├── cloudbase_func_http.py   # 测试脚本：通过 HTTP 网关调用云函数
├── cloudbase_openai.py      # 测试脚本：用 OpenAI SDK 调用云托管服务
└── README.md
```

---

## 一、云函数：01-text-completion

OpenAI 兼容的 **Chat Completions** 接口，底层调用 CloudBase `cloudbase` 大模型（`hy3`）。**仅支持非流式**返回。

### 调用方式

通过 CloudBase HTTP 网关调用：

```
POST https://{envId}.api.tcloudbasegateway.com/v1/functions/{云函数名}
```

请求头：

```
Authorization: Bearer {你的 CloudBase API Key}
Content-Type: application/json
```

### 入参

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 否 | `hy3` | 模型名 |
| `messages` | array | **是** | - | 消息数组，元素为 `{role, content}` |
| `temperature` | number | 否 | - | 采样温度 |
| `max_tokens` | number | 否 | - | 最大生成 token 数 |
| `top_p` | number | 否 | - | nucleus 采样 |
| `frequency_penalty` | number | 否 | - | 频率惩罚 |
| `presence_penalty` | number | 否 | - | 存在惩罚 |
| `stop` | string \| string[] | 否 | - | 停止词 |
| `stream` | boolean | 否 | `false` | **本云函数暂仅支持非流式**，传 `true` 会被忽略 |

### 出参

成功：标准 OpenAI `chat.completion` 对象

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "hy3",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

> 部分模型会额外返回 `message.reasoning_content`（思维链），有则保留。

失败：OpenAI 错误格式

```json
{ "error": { "message": "...", "type": "invalid_request_error", "code": "..." } }
```

### 调用示例

```bash
curl -X POST "https://{envId}.api.tcloudbasegateway.com/v1/functions/hy3_text" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy3",
    "messages": [
      {"role": "system", "content": "你是一个翻译助手"},
      {"role": "user", "content": "把 Hello world 翻译为中文"}
    ],
    "temperature": 0
  }'
```

---

## 二、云函数：03-image-generation

OpenAI 兼容的 **Images API** 接口，底层调用 CloudBase `hunyuan-image` 生图模型，支持 **文生图（T2I）** 和 **图生图（I2I）**。

### 调用方式

同上，通过 CloudBase HTTP 网关调用：

```
POST https://{envId}.api.tcloudbasegateway.com/v1/functions/{云函数名}
```

### 入参

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `prompt` | string | **是** | - | 图片描述，≤500 字 |
| `model` | string | 否 | 自动选择 | 不传则按是否传 `image` 自动选文生图/图生图模型 |
| `n` | number | 否 | `1` | 生成数量（cloudbase 当前仅返回 1 张） |
| `size` | string | 否 | `1024x1024` | 尺寸，见下方可选值 |
| `quality` | string | 否 | - | 质量（接受但 cloudbase 暂未透传） |
| `style` | string | 否 | - | 风格（接受但 cloudbase 暂未透传） |
| `response_format` | string | 否 | `url` | `url` \| `b64_json` |
| `image` | string | 否 | - | 图生图参考图 URL，**传了即走 I2I** |
| `save_to_storage` | boolean | 否 | `false` | 是否上传到云存储持久保存（否则返回的临时 URL 24h 后失效） |

`size` 可选值（注意是 `x` 而非 `×`）：

- `1024x1024`
- `1280x720` / `720x1280`
- `1280x768` / `768x1280`
- `1024x768` / `768x1024`

### 默认模型

- 文生图：`HY-Image-3.0-Plus-4090-Tob-v1.0`
- 图生图：`HY-Image-v3.0-I2I-ToB-v1.0.1`

### 出参

```json
{
  "created": 1700000000,
  "data": [
    { "url": "https://...", "revised_prompt": "..." }
  ]
}
```

- `response_format=b64_json` 时返回 `data[].b64_json`（base64 字符串）
- `save_to_storage=true` 时额外返回 `data[].fileID`（云存储持久 ID）

失败时返回 OpenAI 错误格式。

### 调用示例

文生图：

```bash
curl -X POST "https://{envId}.api.tcloudbasegateway.com/v1/functions/hy_image" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "一只胖胖的橘猫，坐在阳光下的木质窗台上打盹",
    "size": "1024x1024"
  }'
```

图生图 + 上传云存储：

```bash
curl -X POST "https://{envId}.api.tcloudbasegateway.com/v1/functions/hy_image" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "把这张照片改成赛博朋克风格",
    "image": "https://example.com/source.png",
    "save_to_storage": true
  }'
```

---

## 三、云托管：04-hy3-openai

基于 Express + `@cloudbase/node-sdk` 的完整 OpenAI 兼容 HTTP 服务，**支持流式 SSE**，可被任意 OpenAI SDK 直接接入。

### 环境变量配置

在云托管控制台 → 服务设置 → 环境变量中配置：

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `ENV_ID` | 是 | CloudBase 环境 ID |
| `ENV_SECRETID` | 否 | 云托管环境会自动注入临时密钥，跨环境调用时需手动配置 |
| `ENV_SECRETKEY` | 否 | 同上 |
| `API_KEY` | 否 | 客户端鉴权 key，默认 `sk-hy3-cloudbase-openai`，**生产环境务必修改** |
| `PORT` | 否 | 监听端口，默认 `80`（云托管默认） |

### 鉴权

除 `GET /` 和 `GET /health` 外，所有接口均需鉴权，支持两种头部传递方式：

```
Authorization: Bearer {API_KEY}
```

或

```
api-key: {API_KEY}
```

### 可用接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/models` | 是 | 获取所有可用模型列表 |
| GET | `/v1/models/:modelId` | 是 | 获取单个模型详情 |
| POST | `/v1/chat/completions` | 是 | 文本生成（支持 stream SSE 流式） |
| POST | `/v1/images/generations` | 是 | 图片生成（文生图 / 图生图） |
| GET | `/health` | 否 | 健康检查 |
| GET | `/` | 否 | 服务信息 |

### 可用模型

| 模型 ID | 类型 | 说明 |
| --- | --- | --- |
| `hy3` | text | 混元 hy3 文本生成模型 |
| `hy3-preview` | text | 混元 hy3 预览版文本生成模型 |
| `HY-Image-3.0-Plus-4090-Tob-v1.0` | image | 混元生图模型（文生图 T2I） |
| `HY-Image-v3.0-I2I-ToB-v1.0.1` | image | 混元图生图模型（I2I） |

### 1. POST /v1/chat/completions

入参（JSON Body）：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 否 | `hy3` | 模型名 |
| `messages` | array | **是** | - | 消息数组 `{role, content}` |
| `temperature` | number | 否 | - | 采样温度 |
| `max_tokens` | number | 否 | - | 最大生成 token 数 |
| `top_p` | number | 否 | - | nucleus 采样 |
| `frequency_penalty` | number | 否 | - | 频率惩罚 |
| `presence_penalty` | number | 否 | - | 存在惩罚 |
| `stop` | string \| string[] | 否 | - | 停止词 |
| `stream` | boolean | 否 | `false` | 是否流式 SSE 返回 |
| `stream_options` | object | 否 | - | 流式选项，`{"include_usage": true}` 在最后一个 chunk 返回 usage |

**流式说明**：服务端优先调用 `streamText` 推流，若流式失败或为空，会自动降级为 `generateText` 一次性返回。客户端断开连接时会停止推送。

调用示例（非流式）：

```bash
curl -X POST "https://{你的云托管域名}/v1/chat/completions" \
  -H "Authorization: Bearer sk-hy3-cloudbase-openai" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy3",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

调用示例（流式）：

```bash
curl -X POST "https://{你的云托管域名}/v1/chat/completions" \
  -H "Authorization: Bearer sk-hy3-cloudbase-openai" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy3",
    "messages": [{"role": "user", "content": "讲个故事"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

### 2. POST /v1/images/generations

入参（JSON Body）：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `prompt` | string | **是** | - | 图片描述 |
| `model` | string | 否 | 自动选择 | 不传则按是否传 `image` 自动选择 T2I/I2I 模型 |
| `n` | number | 否 | `1` | 生成数量 |
| `size` | string | 否 | `1024x1024` | 尺寸 |
| `response_format` | string | 否 | `url` | `url` \| `b64_json` |
| `image` | string | 否 | - | 图生图参考图 URL，传了即走 I2I |
| `save_to_storage` | boolean | 否 | `false` | 是否上传云存储持久保存 |
| `seed` | number | 否 | - | 随机种子 |
| `revise` | object | 否 | `{value: true}` | 是否返回 revised_prompt |
| `enable_thinking` | boolean | 否 | - | 是否启用思考模式 |

调用示例（文生图）：

```bash
curl -X POST "https://{你的云托管域名}/v1/images/generations" \
  -H "Authorization: Bearer sk-hy3-cloudbase-openai" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "HY-Image-3.0-Plus-4090-Tob-v1.0",
    "prompt": "一只橘猫坐在窗台上",
    "size": "1024x1024"
  }'
```

### 3. GET /v1/models

```bash
curl "https://{你的云托管域名}/v1/models" \
  -H "Authorization: Bearer sk-hy3-cloudbase-openai"
```

返回 OpenAI 标准的模型列表格式。

---

## 四、测试脚本

### 1. cloudbase_func_http.py

通过 CloudBase HTTP 网关调用 **云函数**（01、03）的测试脚本。

**需配置的参数**（脚本顶部）：

| 参数 | 说明 |
| --- | --- |
| `envId` | 你的 CloudBase 环境 ID |
| `token` | 你的 CloudBase API Key |

**可测试的功能**：

- `http_hy_text(envId, cloud_func_name)` —— 调用文本补全云函数，示例包含 system + user 多轮消息、`temperature` 参数
- `http_hy_image(envId, cloud_func_name)` —— 调用图片生成云函数，包含文生图示例，注释中提供图生图 + `save_to_storage` 示例

**使用方法**：修改 `main()` 中的云函数名（部署时叫什么这里就填什么，默认 `hy3_text` / `hy_image`），然后运行：

```bash
python cloudbase_func_http.py
```

### 2. cloudbase_openai.py

使用官方 **OpenAI Python SDK** 调用 **云托管服务**（04）的测试脚本。

**需配置的参数**：

| 参数 | 说明 |
| --- | --- |
| `api_key` | 云托管的 `API_KEY`，默认 `sk-hy3-cloudbase-openai` |
| `base_url` | 云托管服务地址 + `/v1`，例如 `https://xxx.sh.run.tcloudbase.com/v1` |

**可测试的功能**（脚本内以注释形式给出，按需取消注释）：

- 非流式 `chat.completions.create`
- 流式 SSE `chat.completions.create`（含 `stream_options.include_usage`）
- 图片生成 `images.generate`
- 列出模型 `models.list`

**使用方法**：

```bash
pip install openai
python cloudbase_openai.py
```

---

## 部署说明

- **云函数**（01、03）：在 CloudBase 控制台 → 云函数中新建，将对应目录的 `index.js` 与 `package.json` 上传部署即可。云函数运行时会自动注入环境信息，无需额外配置密钥。
- **云托管**（04）：在 CloudBase 控制台 → 云托管中新建服务，上传 `04-hy3-openai` 目录代码（已含 `Dockerfile`），并在服务设置中配置环境变量（见上文）。

## License

ISC
