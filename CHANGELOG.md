# 更新记录

本 Fork（`android-support` 分支）基于上游 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)。
只记录**本 Fork 相对上游的差异**；上游自身的更新请看上游仓库的发布记录。

## 0.7.6-android.1

对应上游基线：`v0.7.6`（DSH 内核 `0.2.0-rc.2`）。

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
