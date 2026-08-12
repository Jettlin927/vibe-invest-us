# vibe-invest-us

一个开源、自托管的个人美股 AI 分析系统。它结合当前行情、历史行情、近实时新闻、财报、估值和个人持仓，形成带具体数据依据的走势分析与条件式方向建议。

## 核心能力

- 手工维护持仓和 USD 现金，并生成最小化个人语境；
- 组合总值、未实现盈亏、资产构成、仓位分布和盈亏贡献；
- 按成交价减仓，卖出所得进入现金并计算已实现盈亏；
- 从启用之日起积累盘中/收盘组合权益历史；
- 当前行情与历史行情主备来源、双新闻源、SEC 财报和首批科技行业估值；
- MA、MACD、RSI、波动率、回撤和量价特征由 Python 确定性计算；
- 基于 `@earendil-works/pi-ai@0.84.1` 的服务端模型适配；
- 异步分析、SSE 实时进度、并发限制、取消和重启中断；
- 冻结快照、原子事实、完整分析轨迹和可追溯报告依据；
- 自动保存、标记、备注、重新打开和删除研究记录；
- Docker Compose 三容器自托管，PostgreSQL 持久卷保存全部产品数据。

## 自托管启动

要求安装 Docker 和 Docker Compose。

```bash
cp .env.example .env
# 编辑 .env，填写模型配置，以及 ALPACA_API_KEY、ALPACA_API_SECRET。
# 建议填写 SEC_USER_AGENT，以启用 SEC 财报数据。
docker compose up --build -d --wait
```

打开 [http://localhost:3000](http://localhost:3000)。默认只在 `127.0.0.1` 开放 Web 与 Analysis API；PostgreSQL 和 Financial Data 仅在 Compose 内部网络可用。

停止容器但保留 PostgreSQL 数据卷：

```bash
docker compose down
```

## 开发验证

Node.js 要求 24 或更新版本。Python 服务使用仓库内虚拟环境：

```bash
npm install
npm run typecheck
npm test
npm run build

python3 -m venv services/market-data/.venv
services/market-data/.venv/bin/pip install -e 'services/market-data[dev]'
services/market-data/.venv/bin/pytest -q services/market-data/tests
```

安装依赖后，可在三个终端分别启动开发进程：

```bash
npm run dev:data
npm run dev:api
npm run dev:web
```

完整验证 Docker 自托管路径：

```bash
npm run verify:self-hosted
```

该命令会构建并启动 PostgreSQL、Financial Data 和 Analysis API，先独立执行数据库 migration，再验证 Web、聚合健康和内部网络，最后停止容器但保留 PostgreSQL 数据卷。

配置真实模型端点后，执行完整“真实数据 → 真实模型 → 研究记录”验收：

```bash
npm run verify:real-analysis
```

## 配置

复制 `.env.example` 后先替换三个 PostgreSQL 密码，再配置自己的模型供应商。初始化账户只在新卷首次启动时创建角色；migration 账户负责 DDL，API 使用仅具产品表 DML 权限的 application 账户。模型凭据只通过运行环境注入，不写入数据库，也不提交到 Git。

Model 模块不内置供应商、模型或服务地址，通过 OpenAI-compatible 协议连接用户在 `.env` 中指定的端点。`MODEL_PROVIDER` 是用于配置和审计的自定义标签；`MODEL_API_PROTOCOL` 可选 `chat-completions` 或 `responses`，其余配置也均无默认值。即使本地端点不校验密钥，也需要手动为 `MODEL_API_KEY` 填写一个非空连接占位值。例如 Docker 访问宿主机 Ollama 时，可配置 `MODEL_API_PROTOCOL=responses` 和 `MODEL_BASE_URL=http://host.docker.internal:11434/v1`。未完整配置模型时，页面仍可维护持仓和查看已有记录，但新分析会明确失败，不会生成伪报告。

金融数据来源顺序、启用状态、超时和诊断模式位于 `services/market-data/config/sources.json`。诊断模式默认关闭；开启后只在 Python 容器临时目录保存限大小、自动过期的供应商响应样本，不进入产品数据库。

## 数据来源与限制

默认数据来源包括 Alpaca、新浪、腾讯、Yahoo Finance、Google News RSS 和美国 SEC。Alpaca 默认使用 Basic 套餐可用的 IEX 单交易所行情；如实例拥有 SIP 权限，可将 `ALPACA_DATA_FEED` 显式改为 `sip`。这些来源由各自提供方运营，可能更改、限流或中断；本项目会展示采用来源和缺口，但不保证数据实时性、完整性或继续可用。新闻只保存元数据和交给模型的有限摘要，不建立新闻全文仓库。

请在使用、公开部署或再分发前自行确认所在地法律以及各数据来源、模型供应商的许可和使用条款。本仓库的 Apache-2.0 许可只覆盖本项目代码，不授予任何第三方数据或模型的权利。

## 持仓与权益历史口径

- 手工新增或更新持仓用于记录当前状态，不代表执行买入，因此不会自动扣减现金；
- 减仓用于记录明确卖出，卖出所得会增加现金，剩余持仓沿用原平均成本；
- 组合总值等于持仓市值加 USD 现金；缺少任一持仓行情时，组合汇总显示不可用；
- 组合权益历史只在全部持仓行情可用时保存，并从启用该能力后开始积累；
- 当前版本由组合页面请求生成盘中快照，自动每日收盘快照仍是后续能力。

## 产品边界

产品不连接券商、不执行交易、不自动调仓，也不提供收益承诺。模型凭据和个人持仓保留在用户自己的实例中。

## License

本项目代码采用 [Apache License 2.0](LICENSE)。
