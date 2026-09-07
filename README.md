# 企业级 AI Agent 服务

## 项目简介

本项目是一个面向生产环境的企业级 AI Agent 基础骨架，采用 **FastAPI** 提供 HTTP API，在 `app/core` 中预留 **Agent 编排**（ReAct、规划、反思）、**RAG**（检索、重排、生成）、**记忆系统**（短/长期）、**工具与意图识别** 等扩展点；在 `app/infrastructure` 中对接 **LLM 路由与熔断**、**Milvus**、**Redis**、**MySQL** 与 **链路追踪**；在 `app/etl` 中承载文档解析、分块与入库流水线。

当前仓库已具备**可用的核心链路**：AI 对话（流式/非流式）、文档上传与列表、**RAG 检索增强问答**（上传文档向量化入库 Milvus，对话时检索上下文并给出引用）。前端为「企业 AI Agent 控制台」，随应用一起提供。

## 架构说明

- **接入层**：`app/main.py` 创建 FastAPI 应用，`app/api/routes/` 按领域拆分路由（对话、文档、健康检查）。
- **领域核心**：`app/core/` 放置与框架无关的业务能力——Agent 图编排、RAG 管道、记忆策略、工具注册与意图识别。
- **基础设施**：`app/infrastructure/` 封装对外部系统的访问（模型网关、向量库、缓存、关系库、可观测性），便于单测与替换实现。
- **数据与 ETL**：`app/models` 定义 API/领域模型；`app/etl` 负责非结构化文档到向量索引的数据流。

部署上可通过 **Dockerfile** 构建应用镜像，**docker-compose** 一键拉起应用与依赖中间件（详见下文 Compose 说明）。

## 技术栈

| 类别 | 技术 |
|------|------|
| Web 框架 | FastAPI、Uvicorn |
| Agent / LLM | LangChain、LangGraph、OpenAI 兼容 API |
| 向量库 | Milvus（pymilvus） |
| 缓存 | Redis |
| 关系库 | MySQL、SQLAlchemy |
| 配置与校验 | Pydantic v2、pydantic-settings |
| 文档处理 | unstructured、pypdf、sentence-transformers |
| 日志与韧性 | loguru、tenacity、httpx |

## 快速开始

### 本地开发

1. Python 3.11+，创建虚拟环境并安装依赖：

```bash
cd project-python
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
pip install -e .
```

2. 复制环境变量并编辑（至少填写 `OPENAI_API_KEY` 等）：

```bash
cp .env.example .env
```

3. 启动 API（需本机或 Compose 中已启动 MySQL / Redis / Milvus 若你要联调全栈）：

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

4. 访问健康检查：<http://127.0.0.1:8000/api/v1/health>

### Docker Compose（内网自用，推荐）

适合**公司内部自己使用**：一台内网服务器/PC 跑一套服务，所有访问者共用服务器上配置的一份 API Key。

**前提**
- 安装 Docker Desktop（Windows/Mac）或 Docker + Compose（Linux）。
- 内存建议 **8GB 以上**（Milvus 较占资源）。
- 一台可被内网访问的机器（记录它的内网 IP，如 `192.168.1.10`）。

**步骤**

1. 复制环境变量模板并编辑，**在服务器上填一份共享的 API Key**：
   ```bash
   cp .env.example .env
   # 编辑 .env：把 OPENAI_API_KEY 填成公司统一使用的 key
   # OPENAI_API_BASE / OPENAI_MODEL / EMBEDDING_MODEL 保持默认（阿里云百炼）
   ```

2. 拉起全套服务（app + mysql + redis + milvus + etcd + minio）：
   ```bash
   docker compose up -d --build
   ```

3. 等所有容器就绪（尤其 **Milvus 首次启动较慢**，需数十秒到数分钟）。查看状态：
   ```bash
   docker compose ps
   ```

4. 浏览器访问前端控制台：
   ```
   http://<服务器内网IP>:8000/
   ```
   - 接口文档：`http://<服务器内网IP>:8000/docs`

**说明**
- `app` 服务会在启动时自动创建数据库表结构（MySQL）。
- RAG：上传文档到「文档库」后会向量化写入 Milvus；在「AI 对话」提问时，系统会检索相关文档分块并生成带**引用**的回答。
- 首次启动 Milvus 需要时间；若 app 过早连不上 Milvus，对话会**降级**为普通问答（不携带引用），Milvus 就绪后自动恢复。

**常用运维命令**
```bash
docker compose down          # 停止并移除容器（保留数据卷）
docker compose up -d         # 重新启动
docker compose logs -f app   # 查看应用日志
docker compose ps            # 查看各服务状态
```

**常见问题**
| 现象 | 处理 |
|------|------|
| 对话报 401 / 模型不可用 | 检查 `.env` 的 `OPENAI_API_KEY`、`OPENAI_API_BASE` 是否正确 |
| `/health/ready` 显示 `database: down` | MySQL 未就绪，等 `docker compose ps` 显示 healthy |
| 对话无引用 | Milvus 未就绪或未上传文档；上传文档后再提问 |
| 端口占用 | 修改 `.env` 的 `PORT` / `docker-compose.yml` 端口映射 |

## 目录结构说明

```
project-python/
├── app/
│   ├── main.py                 # FastAPI 入口
│   ├── config.py               # 配置（pydantic-settings）
│   ├── api/routes/             # 路由：chat、document、health
│   ├── core/                   # Agent、RAG、记忆、工具、意图
│   ├── infrastructure/         # LLM、向量库、缓存、DB、追踪
│   ├── etl/                    # 解析、分块、流水线
│   └── models/                 # schemas、enums
├── requirements.txt
├── pyproject.toml
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## 许可证

MIT（可按团队需要修改）。
