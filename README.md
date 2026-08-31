# LOB Flow

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

从零掌握 AI 应用平台的核心链路，并参考 Dify 分阶段实现模型接入、Prompt 应用、工作流、知识库、工具调用、发布与运行管理。

本项目采用与 LOB Vector 相同的学习方法：围绕一条真实主链路逐阶段实现，每个阶段都保留可运行、可观察、可验收的结果。重点不是复刻 Dify 的全部页面，而是理解一个 AI 应用从配置、编排到发布运行的完整生命周期，并建立源码概念与自研实现之间的映射。

## 核心目标

- 理解 Workspace、App、Draft、Version、Run 等核心领域对象。
- 掌握多模型供应商接入、凭据隔离、参数归一化与流式输出。
- 实现 Chat App、Workflow App 与 Agent App 的最小运行闭环。
- 掌握节点、边、变量、条件、并行、循环、重试和失败分支。
- 接入知识库检索、工具调用、人工确认与运行恢复。
- 理解应用发布、API 调用、权限、多租户和凭据安全边界。
- 建立 Trace、Token、延迟、成本和错误定位能力。
- 能够定位 Dify 对应源码入口，说明平台实现与自研实现的差异。

## 学习主链路

```text
创建 Workspace / App
  → 配置模型与凭据
  → 编辑 Prompt / Workflow
  → 校验并保存 Draft
  → 调试运行
  → 节点调度与流式事件
  → 知识检索 / 工具调用
  → 发布 Version
  → Web App / API 调用
  → Trace、成本与运行记录
```

学习每个模块时都应回答：

- 配置、运行时状态和业务数据分别保存在哪里？
- 一次请求经过哪些服务、节点和事件？
- Draft 与已发布版本如何隔离，修改何时对线上生效？
- 节点失败、进程重启或人工中断后如何继续？
- 模型、知识库、工具和凭据的权限边界在哪里？
- 如何用运行记录与指标证明应用行为符合预期？

## 实施原则

1. 先打通单模型 Chat App，再增加工作流、RAG 和 Agent，避免一开始搭建大而全的平台。
2. 先手写最小 DAG 校验与调度器，再研究 Dify 的图运行实现。
3. 编辑态定义、发布快照和单次运行状态分开建模，禁止线上运行直接读取可变草稿。
4. 节点通过统一输入、输出和事件协议协作，不让调度器依赖具体节点实现。
5. 所有模型与工具凭据只通过环境变量或本地安全存储提供，日志和接口不得回传明文。
6. 每个阶段准备固定应用、输入和预期结果，保留成功、失败与恢复样例。
7. Dify 源码研究服务于理解调用链和设计取舍，不以逐文件翻译为目标。

## 阶段路线

- [x] 阶段 0：AI 应用领域模型与最小 Chat App
- [x] 阶段 1：模型网关与流式运行
- [x] 阶段 2：工作流定义、校验与 DAG 调度
- [ ] 阶段 3：变量系统、控制流与可靠执行
- [ ] 阶段 4：知识库检索与 RAG 节点
- [ ] 阶段 5：工具、Agent 与人工介入
- [ ] 阶段 6：版本发布、API、权限与多租户
- [ ] 阶段 7：可观测、评测与生产化
- [ ] 阶段 8：Dify 源码映射与最终差异清单

详细任务和验收标准见 [实施计划](./docs/IMPLEMENTATION_PLAN.md)。

## 建议技术基线

- 后端先采用 Python 3.12+，使用 `uv` 管理环境、依赖和锁文件。
- PostgreSQL 保存平台配置、版本、运行记录与权限数据。
- Redis 承担队列、运行态协调或事件通知；最小阶段可先用进程内实现。
- Web 层在核心运行链路稳定后接入，避免前期被页面搭建分散重点。
- 模型协议优先支持 OpenAI-compatible 接口，再通过 Adapter 扩展供应商。
- RAG 复用标准检索接口；向量数据库底层原理留在 `lob-vector` 深入研究。
- 持久化状态机与 Checkpoint 原理留在 `lob-graph` 深入研究，本项目关注平台集成与产品生命周期。

## 首个可运行里程碑

阶段 0～2 完成后，应能创建一个工作流应用：输入用户问题，经 Prompt Template 和 LLM 节点生成结果；调试页面或 CLI 能实时展示节点开始、增量输出、完成或失败事件；发布后运行固定版本，后续编辑草稿不影响已发布应用。

## 阶段 0 快速开始

```bash
uv sync
cp .env.example .env
# 在 .env 中填写 PGPASSWORD
uv run lob-flow create-workspace "演示空间"
uv run lob-flow create-app <workspace_id> "客服助手"
uv run lob-flow run <app_id> "如何申请退款？"
cd web && npm install && npm run build && cd ..
uv run lob-flow serve
```

管理端与服务默认监听 <http://127.0.0.1:8000>，OpenAPI 文档位于
<http://127.0.0.1:8000/docs>。前端开发可在 `web/` 执行 `npm run dev`，访问
<http://127.0.0.1:5173>，Vite 会将 `/api` 代理到后端。项目直接使用 PostgreSQL，并将表放在独立的
`lob_flow` Schema 中；连接参数从 `.env` 或标准 `PG*` 环境变量读取，密码不得提交。

应用只允许运行真实的 OpenAI-compatible 模型。新建应用后必须先在「模型设置」中选择
Workspace 级模型配置，否则运行会以 `provider_config_missing` 明确失败。

### 使用真实模型

Stage 1 支持 OpenAI-compatible Chat Completions SSE 协议。先在 `.env` 中配置用于加密
数据库凭据的服务端主密钥：

```dotenv
LOB_FLOW_ENCRYPTION_KEY=使用_openssl_rand_生成的_Fernet_密钥
```

进入管理端「模型设置」，填写供应商名称、Base URL 和 API Key。后端只返回
`has_api_key`，不会回传明文；App Draft 只保存 `provider_config_id`：

```json
{
  "system_prompt": "你是一个有帮助的 AI 助手。",
  "user_prompt_template": "请回答：{input}",
  "model": {
    "provider": "openai_compatible",
    "model": "gpt-5.4",
    "provider_config_id": "模型配置_ID",
    "temperature": 0.2,
    "max_tokens": 1024,
    "timeout_seconds": 30
  }
}
```

API Key 使用 Fernet 在服务端加密后保存到 PostgreSQL，浏览器和 Draft 都不保存密钥。
每次 Run 会保存模型供应商、模型名、Token Usage、结束原因、耗时和错误分类；真实增量
内容继续通过 SSE 和 `message_delta` 事件输出。

### 运行工作流

管理端「工作流」页面提供 `Start → Template → LLM → Answer` 最小 DAG。可以编辑 Prompt
模板、模型配置与 System Prompt，保存时会校验唯一入口、节点引用、不可达节点和循环依赖。
运行时页面实时展示每个节点的状态、输出和最终回答。

工作流定义、运行、节点运行与事件分别保存在 `workflow_drafts`、`workflow_runs`、
`node_runs` 和 `workflow_events`。数据库结构由 Alembic 管理：

```bash
uv run alembic current
uv run alembic upgrade head
```

## 交流与联系

对实现细节有疑问、发现问题或想交流 AI 应用平台与工作流，可以扫码私信：

<p align="center">
  <img src="./docs/images/wechat-private-message-qr.png" alt="虾哥不加班微信私信二维码" width="220">
</p>

也欢迎通过 [GitHub Issues](https://github.com/lobster-bujiaban/lob-flow/issues) 提交可复现的问题和建议。

## 许可证

本项目使用 [Apache License 2.0](./LICENSE) 开源。
