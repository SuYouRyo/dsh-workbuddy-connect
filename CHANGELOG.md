# 更新记录

本 Fork（`android-support` 分支）是**面向手机端的发行版**，基于上游 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)。
只记录**本 Fork 相对上游的差异**；上游自身的更新请看上游仓库的发布记录。

## 0.7.6-android.2

对应上游基线：`v0.7.6`（DSH 内核 `0.2.0-rc.2`）。

### 修复

- **对话被上游拦截时不再直接报错**：CN 网关对部分请求会返回 `400` / `code 11128`
  （`Illegal API invocation from an unapproved channel`，用户看到的是「请求被拦截，请重新发送」），
  并在响应里用 `actions: ["RETRY", …]` **明确要求客户端重发**。此前插件把它当作普通客户端错误直接抛出，
  于是表现为「发一条就报错」。现在：
  - 仅当状态为 `400` **且**（`code === 11128` 或 `actions` 含 `RETRY`）时**重发一次**；其余 4xx/5xx 一律不重试，
    避免畸形请求被重发、积分被重复扣；
  - 每次重发都重新生成 `X-Conversation-*` 三件套（复用旧值等于往刚被拒的通道里再送一次）；
  - 调用方已中止（`AbortSignal`）时不重发。
- **CN 请求体归一化补全**：`prepareCnChatBody()` 现在也先经过共享的 `prepareChatBody()`，
  因此同样强制 `stream: true` 并把 `role: "developer"` 改写为 `system`——后者正是上游返回 `11128`
  的一个已知触发点。此前只有国际版路径做这件事。

### 诊断结论（供后续排查参考）

对 `copilot.tencent.com` 的实测排除了这些猜测：客户端 UA / `X-User-Id` / `X-Domain` / `X-IDE-*`
身份头、请求体积（293 KB、200 轮历史、60 个工具定义）、并发（6 路并发全部 200），
以及 `cache_control`、分片 content、`tool_calls` 等结构差异。唯一能稳定复现同一条「请求被拦截」文案的
是 `role: "developer"`；其余形态要么 200，要么返回别的错误码（11101 / 11135 / 11148）。

### 测试

- 新增 `tests/blocked-chat-retry.spec.ts`（12 条）：判定边界、重发一次即成功、重发使用全新会话三件套、
  只重发一次、非可重试错误不重发、已中止不重发、CN 归一化改写 `developer` 且幂等、CN 与国际版一致。

## 0.7.6-android.1

对应上游基线：`v0.7.6`（DSH 内核 `0.2.0-rc.2`）。

### 定位

**手机端优先**：目标场景是在 Android 上运行 DeepSeek Harness（如 [DSHA](https://github.com/DSH-APP/DSHA)）时，直接使用 WorkBuddy 账号里的模型。上游只支持复用桌面 App 的登录，手机上没有桌面 App、也没有解密其凭据所需的系统钥匙串，因此**无法登录**；本 Fork 补上设备码登录，使手机可以独立完成登录与续期。

### 新增

- **设备码登录（`login` 子命令）**：在没有 WorkBuddy 桌面 App 的机器上（手机、无头服务器、容器）发起一次授权，在任意浏览器里批准，即可取得凭据并使用模型。
  - `dsh plugin --profile web exec dsh-workbuddy-connect login`
  - 支持 `--provider workbuddy-ai`（国际版）、`--timeout <秒>`、`--json`。
  - 授权链接一次性有效；超时或 Ctrl-C 后重跑即可换新链接。
- `WorkBuddyCredentialStore.adopt()`：把本进程自行取得的凭据写入**插件自有副本**（`$DSH_HOME/.workbuddy-auth.json`，0600），写入前做 region 校验，拒绝把一版的令牌存到另一版名下。
- `src/device-login.ts`：设备授权三个端点（state / token / account）的封装，按 region 分表（国内版 `copilot.tencent.com`，国际版 `www.workbuddy.ai`），请求头沿用官方 CLI 客户端身份。

### 行为说明

- 仍然**只写**插件自有副本，从不写桌面 App 的凭据文件；在有桌面 App 的机器上，桌面文件继续是「当前登录的是谁」的权威，因此登录不会冒充别的账号。
- 登录成功后宿主在**下一个请求**就用上新凭据，不需要重启。
- 过期令牌照旧由插件自动 refresh，无需重新登录。

### 验证

- 新增 `tests/device-login.spec.ts`（11 条，全绿）：端点与请求头、pending 轮询、令牌与身份字段映射、超时、跨产品拒绝、中止、`adopt()` 的正反用例。
- 类型检查、构建通过；全量测试仅上游既有的 `tests/app-version.spec.ts › still answers when the cache cannot be written` 在 proot 容器里失败（它依赖往 `/proc/...` 写入的失败方式，5s 超时），与本 Fork 改动无关，未做修改以保留上游原样。
- 已在 Android（DSHA 的 Ubuntu aarch64 / glibc 容器，DSH `0.2.0-rc.2`）真实走通：发起授权 → 浏览器批准 → 落盘 → 用该凭据读取真实积分余额，并在该会话里完成真实对话。
