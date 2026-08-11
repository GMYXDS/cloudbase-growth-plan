import json
import requests

envId = "g***e"  # 你的cloudbase 环境id
token = "eyJ**ZNw"  # 你的cloudbase apikey
headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
    "Accept": "application/json",
}


def http_hy_text(envId, cloud_func_name):
    url = f"https://{envId}.api.tcloudbasegateway.com/v1/functions/{cloud_func_name}"
    payload = json.dumps(
        # {
        #     "model": "hy3",
        #     "messages": [{"role": "user", "content": "今天日期是什么"}],
        #     # "temperature": 0.7,
        #     # "max_tokens": 500
        # }
        {
            "model": "hy3",
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": '你是一个专业的简体中文母语译者，需将文本流畅地翻译为简体中文。\n\n## 翻译规则\n1. 仅输出译文内容，禁止解释或添加任何额外内容（如"以下是翻译："、"译文如下："等）\n2. 返回的译文必须和原文保持完全相同的段落数量和格式\n3. 如果文本包含HTML标签，请在翻译后考虑标签应放在译文的哪个位置，同时保持译文的流畅性\n4. 对于无需翻译的内容（如专有名词、代码等），请保留原文\n\n## Context Awareness\nDocument Metadata:\nTitle: 《Options》\n\n',
                },
                {
                    "role": "user",
                    "content": "翻译为简体中文（仅输出译文内容）：\n\nHello world",
                },
            ],
        }
    )
    response = requests.request("POST", url, headers=headers, data=payload)
    print(response.text)


def http_hy_image(envId, cloud_func_name):
    url = f"https://{envId}.api.tcloudbasegateway.com/v1/functions/{cloud_func_name}"
    payload = json.dumps(
        {
            "prompt": "一只胖胖的橘猫，坐在阳光下的木质窗台上打盹，温暖的阳光照在毛茸茸的毛发上，水彩插画风格，柔和暖色调，画面温馨治愈",
            "size": "1024x1024",
        }
    )
    # temp_image = "https://hunyuan-base-prod-1258344703.cos.ap-guangzhou.myqcloud.com/openapi/text2img/6af4f262d2ff6d218d3a97a432f5ad31.png"
    # payload = json.dumps(
    #     { "prompt": '把这张照片改成赛博朋克风格', "image": temp_image, "save_to_storage": True }
    # )
    response = requests.request("POST", url, headers=headers, data=payload)
    print(response.text)


def main():
    http_hy_text(envId, "hy3_text")
    # http_hy_image(envId,"hy_image")


if __name__ == "__main__":
    main()
