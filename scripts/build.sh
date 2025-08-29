#!/bin/bash

# 生产环境打包脚本
# 打包前端应用、服务器并集成到Electron中

echo "📦 开始生产环境打包..."

# 清理之前的构建
echo "🧹 清理构建目录..."
rm -rf dist release server/bin

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装根目录依赖..."
    npm install
fi

if [ ! -d "server/node_modules" ]; then
    echo "📦 安装服务器依赖..."
    cd server && pnpm install && cd ..
fi

# 构建前端应用
echo "🔨 构建前端应用..."
npm run build

# 构建服务器
echo "🔨 构建服务器..."
npm run server:build

# 创建服务器资源目录
mkdir -p server/bin/api_js/util server/bin/api_js/module

# 打包Electron应用
echo "📦 打包Electron应用..."
npm run dist:all

echo "✅ 打包完成！输出目录: release/"