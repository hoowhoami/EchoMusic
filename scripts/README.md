# 开发和生产环境脚本说明

## 首次设置

在运行任何命令之前，请确保安装了所有依赖：

```bash
# 安装所有依赖（根目录和server目录）
npm run install:all
```

或者分别安装：

```bash
# 安装根目录依赖
npm install

# 安装server目录依赖（使用pnpm）
npm run install:server
```

## 开发环境

### 方法1：使用脚本（推荐）
```bash
./scripts/dev.sh
```

### 方法2：使用npm命令
```bash
# 同时启动所有服务
npm run dev:all
```

### 分别启动服务
```bash
# 启动API服务器（端口3001）
npm run server:dev

# 启动前端开发服务器（端口3000）
npm run dev

# 启动Electron应用
npm run electron:dev
```

## 生产环境

### 方法1：使用脚本（推荐）
```bash
./scripts/build.sh
```

### 方法2：使用npm命令
```bash
# 构建所有（前端和服务器）
npm run build:all

# 打包成可执行文件
npm run dist:all
```

### 分别构建
```bash
# 构建前端应用
npm run build

# 构建服务器（打包成JS）
npm run server:build

# 打包服务器成可执行文件
npm run server:pkg
```

## 端口配置

- **前端开发服务器**: http://localhost:3000
- **API服务器**: http://localhost:10086
- **生产环境**: API服务器内嵌在Electron应用中，运行在10086端口

## 注意事项

1. Server目录使用pnpm作为包管理器，不是npm
2. 生产环境中，服务器会作为Electron应用的一部分自动启动
3. 开发环境中需要先启动服务器，再启动前端和Electron