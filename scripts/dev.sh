#!/bin/bash

# 开发环境启动脚本
# 同时启动服务器、前端开发和Electron应用

echo "🚀 启动开发环境..."

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装根目录依赖..."
    npm install
fi

if [ ! -d "server/node_modules" ]; then
    echo "📦 安装服务器依赖..."
    cd server && pnpm install && cd ..
fi

# 启动所有服务
echo "🌟 启动所有服务..."
npm run dev:all