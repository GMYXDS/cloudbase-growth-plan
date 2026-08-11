FROM node:18-alpine

WORKDIR /app

# 先复制 package.json 安装依赖（利用 Docker 层缓存）
COPY package.json ./
RUN npm install --production

# 复制源码
COPY . .

# 云托管默认监听 80 端口
EXPOSE 80

CMD ["node", "app.js"]
