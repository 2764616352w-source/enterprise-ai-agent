# 部署上线指南

> 本文件面向「公司内部自用」场景：一台内网服务器跑一套服务，所有访问者共用服务器上配置的一份 API Key。

- 前置条件
- 步骤 1：上传项目到服务器
- 步骤 2：配置环境变量
- 步骤 3：构建应用镜像
- 步骤 4：一键拉起全栈
- 步骤 5：查看状态 & 等待就绪
- 步骤 6：验证服务
- 步骤 7：常用运维命令
- 步骤 8：数据持久化说明
- 步骤 9：（选做）对外访问 - 反向代理 + HTTPS
- 上线前检查清单

---

## 前置条件

- 一台可被内网访问的机器（**推荐 Linux**）。
- 内存 **8GB 以上**（Milvus 较占资源），建议 16GB。
- 已安装 **Docker** + **Docker Compose**。
  - Linux：`sudo apt install docker.io docker-compose-plugin`
  - Windows：安装 Docker Desktop
- 一个可用的**阿里云百炼 DashScope API Key**（用于 LLM + Embedding）。

---

## 步骤 1：上传项目到服务器

项目根目录应包含：`app/`、`static/`、`Dockerfile`、`docker-compose.yml`、`requirements.txt`、`pyproject.toml`、`.env.example`、`README.md`。

```bash
# 方式一：scp 拷贝（本地在 D:\xiangmu_total\xiangmu-06）
scp -r D:/xiangmu_total/xiangmu-06/* user@server:/opt/ai-agent/

# 方式二：git 拉取
git clone <repo-url> /opt/ai-agent

cd /opt/ai-agent
```

---

## 步骤 2：配置环境变量

```bash
cp .env.example .env
vi .env
```

关键配置项（**由服务器管理员统一填写**）：

```ini
APP_NAME=enterprise-ai-agent
APP_ENV=production        # 生产环境
DEBUG=false               # 关闭调试
PORT=8000

# 公司统一 API Key（必填）
OPENAI_API_KEY=sk-你的公司统一key
OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_MODEL=qwen-plus
EMBEDDING_MODEL=text-embedding-v3

# MySQL（compose 内使用容器主机名 mysql，勿填 localhost）
DATABASE_URL=mysql+aiomysql://agent:agent@mysql:3306/agent_db
```

> `.env` 已被 `.gitignore` 忽略，**不会被 commit / 打包进镜像**，API Key 安全。

---

## 步骤 3：构建应用镜像

```bash
docker compose build app
# 或一次性构建所有服务镜像
docker compose build
```

构建时会将 `app/` 与 `static/` 一起打入 `python:3.12-slim` 镜像，前端随镜像发布，无需单独部署前端。

---

## 步骤 4：一键拉起全栈

```bash
docker compose up -d --build
```

依次启动：

| 服务 | 说明 | 端口 |
|------|------|------|
| `mysql` | 关系库，启动时自动建表 | 3306 |
| `etcd` | Milvus 元数据依赖 | 2379 |
| `minio` | Milvus 对象存储依赖 | 9000/9001 |
| `milvus` | 向量库 | 19530 |
| `redis` | 缓存 | 6379 |
| `app` | 业务 API + 前端控制台 | 8000 |

---

## 步骤 5：查看状态 & 等待就绪

```bash
docker compose ps
```

- `mysql` 应显示 `(healthy)`（已配置 healthcheck）。
- `milvus` **首次启动较慢**（数十秒到数分钟），请耐心等待。
- `app` 应显示 `Up`。

> 若 `app` 过早连不上 Milvus，对话会降级为普通问答（代码已做优雅降级），Milvus 就绪后自动恢复引用检索。

---

## 步骤 6：验证服务

```bash
# 健康检查
curl http://localhost:8000/api/v1/health
# => {"status":"ok"}

# 就绪检查（MySQL 联通）
curl http://localhost:8000/api/v1/health/ready
# => {"status":"ready","database":"up","app_env":"production"}
```

浏览器访问：

- 前端控制台：`http://<服务器内网IP>:8000/`
- 接口文档：`http://<服务器内网IP>:8000/docs`

**功能验证（RAG）**

1. 「文档库」上传一份你自己的文档（txt / pdf 均可）。
2. 切到「AI 对话」提问文档相关内容（如“这份文档的核心内容有哪些？”）。
3. 回答下方应显示**「检索引用」**块，且内容基于文档。

---

## 步骤 7：常用运维命令

```bash
docker compose logs -f app     # 看应用日志
docker compose restart app     # 重启应用
docker compose up -d           # 重新启动（已构建则直接启动）
docker compose down            # 停止并移除容器（保留数据卷）
docker compose down -v         # 停止并删除数据卷（慎用，会清空数据）
```

链路追踪 ID（`trace_id`）可从应用日志中查看。

---

## 步骤 8：数据持久化说明

- 所有中间件数据存放在 **Docker named volumes**：`mysql_data`、`redis_data`、`etcd_data`、`minio_data`、`milvus_data`。
- `docker compose down` 不会删除数据；只有 `down -v` 才会清空。
- 如需备份，导出对应 volume 或数据库即可。

---

## 步骤 9：（选做）对外访问 —— 反向代理 + HTTPS

若要让不在同一内网网段的人访问，可前置 **Nginx/Traefik** 反向代理到 `app:8000`：

```nginx
# Nginx 示例
location / {
    proxy_pass http://<服务器IP>:8000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

配好域名与 TLS 证书后，即可通过 `https://你的域名/` 访问。**内网自用通常不需要这一步。**

---

## 上线前检查清单

- [ ] `.env` 已设 `APP_ENV=production`、`DEBUG=false`
- [ ] `OPENAI_API_KEY` 已填入公司统一 key
- [ ] 内存 ≥ 8GB
- [ ] 端口 `8000` 未被占用
- [ ] 中间件端口是否映射到宿主机（按需，只需对外暴露 8000）
- [ ] `docker compose build` 构建成功无报错
- [ ] 各容器 `Up`，`mysql` 显示 `healthy`
- [ ] 上传文档后对话能返回**引用**（RAG 生效）
