from openai import OpenAI

client = OpenAI(
    api_key="sk-hy3-cloudbase-openai", # 云托管默认apikey,生成环境请配置环境变量
    base_url="https://h**21.sh.run.tcloudbase.com/v1" # 云托管服务地址
)

# 非流式
# resp = client.chat.completions.create(
#     model="hy3",
#     messages=[{"role": "user", "content": "你好，你是什么模型，知识库截止到什么时候"}]
# )
# print(resp.choices[0].message.content)

# 流式 SSE
stream = client.chat.completions.create(
    model="hy3",
    messages=[{"role": "user", "content": "你是什么模型！"}],
    stream=True,
    stream_options={"include_usage": True}
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)

# # 生图
# img = client.images.generate(
#     model="HY-Image-3.0-Plus-4090-Tob-v1.0",
#     prompt="一只橘猫坐在窗台上",
#     size="1024x1024"
# )
# print(img.data[0].url)

# # 列出模型
# models = client.models.list()
# for m in models.data:
#     print(m.id)