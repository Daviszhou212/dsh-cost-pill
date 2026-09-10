# dsh-cost-pill

DSH Web 插件：在输入框下方的统计行**同一行**里，加一枚**与官方统计 pill 完全同款**的
「本会话 API 费用 · 余额 · 缓存命中」胶囊，点击向上展开明细面板（分时段金额、账户余额、
分模型明细、单价表与价目来源）。

- **视觉零发明**：pill 与面板的每个数值都逐条抄自官方源码 —— `StatsPills.module.css`
  （颜色 token、字号、`gap`、`padding`、`border-radius`、hover 态、`sep` 的 margin）与
  `stat-dialog.module.css`（面板底色、阴影、圆角、`dl` 网格列宽与右对齐）。
- **与官方统计行同排**：官方统计行的根节点自带 `data-composer-stats` 标记，pill 直接
  挂进那一行，和「N 轮 M 步 · tok/s」「tok · 缓存命中」并排；官方行不存在时（其无统计
  内容时根本不渲染）自动降级为独占一行的居中布局。
- **不猜官方文案**：定位靠官方自己的属性标记与结构，不靠文本正则（第三方插件常用的
  `/^\d+ 轮 · \d+ 步/` 这类匹配，官方改一次文案就失效）。
- **走官方投影缝**：宿主半边把费用注册成 `ctx.sessionProjections` 的 `costPill` 单元，
  浏览器半边用插槽运行时注入的 `useProjection('costPill')` 读取；跨分页、跨压缩存活，
  冷启动走检查点，插件卸载自动摘除 key。
- **价目在线刷新且有闸门**：启动时后台从官方定价页刷新价目（带 TTL 缓存、多重校验、
  离线与校验失败都能降到上一份好数据），面板里明写「价目来源 + 核验日期」。
- **零构建**：手写 CJS client bundle（同社区 `dsh-annotation` 做法），没有 build 步骤，
  改完源码重启即生效。
- **模型可见面为零**：不注入任何提示词、消息、工具或模型调用。

## 安装

从 npm（发布后）：

```powershell
dsh plugin --profile web add dsh-cost-pill
```

从 GitHub 仓库安装（发布后）：

```powershell
dsh plugin --profile web add github:Daviszhou212/dsh-cost-pill
```

源码开发用 `link:`（改完源码重启 `dsh web` 即生效）：

```powershell
dsh plugin --profile web add link:<插件源码目录>/dsh-cost-pill
```

装完重启 `dsh web`，然后浏览器硬刷新（`Ctrl+Shift+R`，bundle 地址带内容哈希）。
打开任意会话，官方统计行里会出现一枚 `费用 ¥2.033 · 余额 ¥105.82 · 命中 99.5%` 胶囊；
会话还没有计费样本时不显示（与官方统计行「无内容即不显示」一致）。

卸载：

```powershell
dsh plugin --profile web remove dsh-cost-pill
```

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里用 id 定向覆盖价格表：

```yaml
- id: cost-pill
  config:
    pricing:
      deepseek-flash:                      # 键 = 模型 id（大小写不敏感，支持最长前缀匹配）
        offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }
        peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
      acme/mystery-1:                      # 也可写完整 provider/model：同一模型分渠道定价
        input: 3                           # 不分时段写法：各时段同价
        output: 6
```

选价顺序：**完整 `provider/model` 精确匹配 → 模型 id 精确匹配 → 两者各自的最长前缀匹配**。
所以 `deepseek-flash` 能同时命中 `deepseek-official/deepseek-flash`，而
`deepseek-v4-flash:0731` 这类带变体后缀的 id 会落到 `deepseek-v4-flash`。

单位固定为**元 / 百万 token**，`cacheWrite` 官方无独立价，按未命中输入价计。

在线刷新的配置（`pricingRefresh` 段，整段可省）：

```yaml
- id: cost-pill
  config:
    pricingRefresh:
      enabled: true          # false = 只用内置价目，完全不联网
      ttlMs: 86400000        # 缓存存活时间（默认 24 小时）；TTL 内不重新抓取
      timeoutMs: 15000       # 单次抓取超时
      url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'   # 必须 https
      cachePath: ''          # 默认 $DSH_HOME/storages/dsh-cost-pill-pricing.json
```

## 价目来源

三级优先：**内置价目 < 在线抓取的官方页价目 < 你的 `pricing` 配置**。

内置价目逐条核对自官方定价页，核对于 **2026-09-10**：

| 模型 | 缓存命中 空闲/高峰 | 缓存未命中 空闲/高峰 | 输出 空闲/高峰 |
| --- | --- | --- | --- |
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

页面脚注（决定了内置表的处理）：① 模型名请用 `deepseek-flash`，旧名
`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 已下线但请求仍按 Flash 价计费，
所以旧名保留同价条目；② `deepseek-v4-pro` 计划下线，**2026-09-14 12:00 起**其请求全部
路由到 V4.1 Flash 并按 Flash 价计费（届时该条目应更新或删除）；③ 空闲价为高峰价的一半，
高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00。

**在线刷新不是"抓了就信"**，而是一条有闸门的链路：

1. 只抓白名单 HTTPS 地址，单请求、带超时，**后台执行、绝不阻塞**注册与渲染；
2. 严格解析：先定位含「缓存命中」的表格，按表头把模型列映射成模型 id，只认
   「百万tokens输入（缓存命中/未命中）」「百万tokens输出」三类行（页面上还有并发限制
   2500/500、上下文长度 1M 等数字，绝不能被当成价格）；
3. 多重校验：**高峰必须恰为空闲的两倍**（官方脚注 3 的不变式）、各桶大小关系合理、
   必须解析出 flash 系模型 —— 任何一条不过就**整表丢弃**，继续用上一份好数据；
4. 落盘缓存（默认 24 小时 TTL）：之后启动先读缓存，TTL 内不再抓取；断网时用上次的
   好数据兜底，而不是回退到写死的旧价；
5. 面板里的「价目来源」一行会写明当前用的是内置价、在线刷新、本地缓存，还是
   刷新失败/校验不通过而回退，并附核验日期与失败原因。

> 刷新在**下一个计费样本**到来时体现：投影注册表只在事件提交时重算 `wire.view`，
> 没有主动通知接口 —— 这是投影契约的取舍。

## 计费口径

- **数据来源**：只认 provider 在 `assistant/message` 事件里上报的 `usage`
  （`inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`）。
  流式 `assistant/chunk` 的 usage 是同一次尝试的中间快照，计入会重复计费，因此刻意忽略
  —— 代价是费用在**每次模型调用完成时**更新，而不是逐 token 跳动。
- **时段归属**：按事件自身的 `time` 时间戳判定，落到高峰或空闲两个桶里分别计价。
  高峰 = 北京时间（UTC+8，无夏令时）**工作日** 09:00–12:00、14:00–18:00；
  周末全天按空闲价（官方 2026-08-23 起的规则）。
- **归因**：按事件的 `message.source` 取 `provider/model`，因此多模型混合会话、以及
  经 fallback 切换后的调用都能各自计价；拿不到 source 的样本落到 `unknown/unknown`，
  会显示为「价格未知」而不是被静默算进别的模型。

## 账户余额

面板里的「账户余额」区显示 `total / 充值 / 赠送`，pill 上直接带一段 `余额 ¥x.xx`。

- **数据通路**：宿主半边注册一条 **loopback-only** 的精确路由
  `/api/cost-pill/balance`，由它用提供商自己的账户接口
  （`GET {baseURL}/user/balance`，Bearer 鉴权）取数。浏览器只拿到余额数字，
  **API Key 始终留在宿主进程**，不下发、不落盘。
- **凭据解析**：baseURL 与 API Key 的环境变量名从 settings 的 `llm-deepseek`
  命名空间读取（默认 `https://api.deepseek.com` 与 `DEEPSEEK_API_KEY`），再经
  harness 的 credentials 缝解析出真实 Key。所以 Key 只需按 DSH 的常规方式配置一次。
- **围栏**：只接受 peer socket 为本机 **且** Host 头指向本机的 GET 请求（Host 头
  是客户端可控的，只作附加校验）；非 GET 405、外来调用 403。
- **刷新**：挂载拉一次，之后每 5 分钟一次；面板里的「刷新」按钮走 `?refresh=1`
  绕过宿主 120 秒 TTL 缓存，并带单飞闸（连点不会把上游打出一串请求）。
- **降级**：拿不到余额时 pill 少一段、面板显示原因（未配 Key / Key 被拒 / 限流 /
  上游不可用 / 本地路由不可达），费用部分不受影响。
- **配置**（插件行 config 的 `balance` 段，均可省）：

  ```yaml
  - id: cost-pill
    config:
      balance:
        enabled: true          # false 则完全不注册余额路由
        lowThreshold: 10       # 低于该值标红（默认 10 元）
        cacheMs: 120000        # 宿主侧 TTL 缓存
        timeoutMs: 15000       # 上游超时
  ```

### 用余额给价目表定论

余额是**真实扣费**的结果，因此可以拿它校准价格：记下当前余额 → 用一段只跑本插件
会话的时间 → 再查余额，`Δ余额 ÷ 插件算出的费用` 就是价目表的偏差倍数
（≈2.5 说明缓存命中价该用 0.05 而不是 0.02）。多跑几轮、让缓存命中占比不同，
三个单价可以分别解出来。

## 已知限制

- **不做跨调价的历史分段**：所有历史样本都按**当前**价目表重算。2026-09-10 12:00
  之前的调用当时更贵（命中 0.05 / 未命中 1.5 / 输出 4.5），因此旧会话的金额会偏低。
  需要精确对账请用 `scripts/fold-session.mjs` 或在 `pricing` 里按需覆盖。
- **在线刷新在下一个计费样本体现**：投影注册表只在事件提交时重算 `wire.view`，刷新本身
  不会立刻改变界面上的数字。
- **金额是估算值，不等于账单**：中转渠道、合同折扣、赠送额度、按小时计费的缓存存储等
  都无法从会话 token 推算。
- **面板是自锚定的**（`position: absolute` 相对 pill），不做官方那种 fixed + 视口
  边缘重排；极端窄窗口下可能贴边，但已被 `max-width: min(440px, 100vw - 24px)` 夹住。
- **图标是自绘内联 SVG**：官方图标包 `dsh-client-ui-primitives` 里的是 React 组件，
  而本插件的 pill/面板由命令式 DOM 构建（为了能安全地合入官方那一行），React 元素不能
  直接当 DOM 节点用；要渲染官方图标就得引入 react-dom，而它并不保证在模块表里存在。
- **只在 Web 面渲染**：TUI/其他客户端没有该插槽。

## 对账脚本

```powershell
node scripts/fold-session.mjs "$env:USERPROFILE\.dsh\sessions\<workspace>\<session>\session.v3.jsonl.zstd"
```

用同一套折叠逻辑直接读会话日志（追加式多帧 zstd，按魔数切帧解压）并打印分桶金额，
可与 DeepSeek 平台用量页交叉核对。

## 文件结构

| 文件 | 角色 |
| --- | --- |
| `lib/pricing.js` | 纯逻辑：峰谷判定、路由选价、金额、事件折叠、视图折算（零依赖，可单测） |
| `lib/price-source.js` | 在线价源：官方页解析、多重校验、TTL 缓存、降级（抓取/校验/断网都不抛） |
| `lib/balance.js` | 纯逻辑 + 一次 GET：余额返回体解析、loopback 围栏判定、账户接口查询 |
| `lib/index.js` | 宿主半边：注册 `costPill` 会话投影 + loopback 余额路由 + 后台价目刷新 |
| `lib/client.js` | 浏览器半边：官方同款 pill（费用 · 余额 · 命中）+ 点击展开面板（手写 CJS bundle） |
| `scripts/fold-session.mjs` | 对账脚本：拿真实会话日志跑同一套折叠逻辑 |
| `test/pricing.test.mjs` | 单测：时段边界、周末、选价、折叠归因、视图折算、**价格门禁** |
| `test/price-source.test.mjs` | 单测：**对真实页面夹具**的解析、校验、优先级、缓存与各条降级路径 |
| `test/balance.test.mjs` | 单测：loopback 围栏、返回体解析、错误映射、带 Bearer 的查询 |
| `test/host.test.mjs` | 单测：走 `apply()` 真实入口的投影注册 + 余额路由（凭据/缓存/强制刷新/围栏） |
| `test/client.smoke.test.mjs` | 冒烟：DOM 垫片 + React 替身跑真实 client bundle（同行合并/降级/面板内容/余额两态） |
| `test/fixtures/` | 夹具：官方定价页里那张价格表的原样摘录（带抓取时间与来源） |

> `lib/index.js` 会尝试 `import '@deepseek-ai/schemastery'` 给投影加真实 schema 校验；
> 若该包在当前解析根下不可用（本地 `link:` 安装时常见），自动退化为直通 schema
> ——注册表只用到 schema 的 `.parse()`，功能不受影响，只是少了校验。

## 测试与发布

```powershell
npm run check              # 五个入口语法检查 + 43 项测试
npm publish --dry-run      # 预演发布（10 个文件，约 33 kB）
npm publish                # 真正发布（需先 npm login）
```

