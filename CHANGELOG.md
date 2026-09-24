# Changelog

本文件记录对外可见的变更。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 0.1.5 — 2026-09-24

**修复（适配 DSH 0.1.7-alpha.2 的 v4 会话日志）**

- **子代理 / agent-team 费用归集在 alpha.2 上完全失效**：`lib/tree.js` 两处硬编码
  `session.v3.jsonl.zstd`，而 alpha.2 起新会话只写 `session.v4.jsonl.zstd` ——
  `listWorkspaceSessions` 扫不到任何子会话头部，`sessionLogFile` 对 v4-only 会话
  必然落空，树路由恒返回 `total=0 / count=0`。客户端因「无子代理」静默回退为仅
  本会话费用，面板「子代理会话」区永不出现，全程无任何报错。
- 现按 **v4 优先、v3 兜底**探测日志文件名（升级前的老会话两代并存，v3 是死数据，
  必须优先 v4）。归集条件 `origin === 'subagent'` 无需改动：实测 agent-team 队员的
  会话头部即 subagent 语义（`origin: 'subagent'`、`parentSession`、`delegationDepth`），
  天然被覆盖。
- 已在真实磁盘数据上验证（1 本体会话 + 1 subagent + 1 agent-team 队员的树正确归集
  与计价），57 项测试全过。

## 0.1.4 — 2026-09-20

**修复（适配 DSH 0.1.7-alpha.1）**

- **面板透明**：alpha 把 `--dsw-specific-menu` 从不透明色改为半透明（浅 `#f8f9fa94` /
  深 `#30313680`），官方面板配套加了毛玻璃 `backdrop-filter`。本插件的面板只抄了背景
  色没抄模糊，内容直接透底。现已补上
  `backdrop-filter:var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))`
  （带 fallback，旧版无此变量时也不受影响）。
- sep 分隔点颜色 `--dsw-alias-separator-primary` 在 alpha 里被官方 CSS 引用却无人定义
  （上游回归），兜底到 `--dsw-alias-label-tertiary`。
- pill 字号对齐 alpha 的官方统计行（`calc(--dsh-content-font-size-secondary - 1px)`）。
- 已核对面板用到的全部 22 个主题 token：除上述三处外其余在 alpha 中均有定义。

## 0.1.3 — 2026-09-20

**修复**

- **pill 钉不到最右 + 挤压官方 pill 的真正根因**：放置逻辑依赖官方 StatsPills 根节点
  的 `data-composer-stats` 标记，但该属性在当前 DSH 版本里**并不存在**（全仓库可证），
  合并分支从未激活 —— pill 长期处于独立态，其 `width:100%` 把同行的官方 pill 挤出
  省略号；上一版加在合并态上的 `order:999` 自然也从未生效。
  现改为纯插槽方案：官方 stats（order 0）与本插件（order 1）都是
  `conversation.composer.dock` 列表插槽的占用者，位置由插槽契约保证；pill 根节点改为
  紧凑项（`flex:none`，不再 `width:100%`），`margin-left:auto` 钉在 dock 行最右端、
  ContextMeter 左侧；删除全部搬运/观察者代码；面板改为右对齐锚定（贴右不溢出视口）。

## 0.1.2 — 2026-09-20

**修复**

- 合并态 pill 钉在官方统计行**最右端**（`order:999` + `margin-left:auto`）——此前
  `appendChild` 挂到行尾后，React 重渲染会把后插入的官方节点排到它后面。
- pill / 面板主金额在存在未定价模型时带「+」后缀：未定价用量此前被静默按 0 计入，
  显示 ¥0.0000 但 token 数照涨，极具误导性（面板里本来就有「价格未知」行）。

**新增**

- 内置价目加入 `glm-5.3-flash`（zai-coding-cn 路由）：标准价 输入 0.8 / 缓存命中
  0.23 / 输出 2.8 元/M，不分峰谷（bigmodel.cn，2026-09-20 核对；限时五折已到期不采用）。
  GLM Coding 套餐用户注意：套餐额度内边际成本为 0，此数为按 API 价的等效估算。
- 核验日期更新为 2026-09-20（DeepSeek 价目同日复核无变化）。

## 0.1.1 — 2026-09-18

**修复**

- **子代理树汇总从未生效**（价格只显示本会话、比真实消耗低数倍）：
  - `findWorkspaceDir` / `sessionLogFile` 拼路径时漏掉了 `sessions/<工作区目录>/`
    这一层，任何会话都定位不到日志（`workspace-not-found`）；且顶层会话目录带
    `session-` 前缀而子代理不带，归一化后的 id 拼不出真实目录名 —— 现在两种写法都探测。
  - `createTreeSource` 闭包引用了不在作用域内的 `holder`，树路由一被调用就抛
    `ReferenceError`；客户端把失败静默吞掉后永远回退到「仅本会话」费用。现在价目
    持有器作为参数传入。
  - `balance.enabled=false` 会连带跳过树路由注册 —— 两个独立功能解耦。
  - `sessionsRoot()` 未设 `DSH_HOME` 时默认 `~`，对齐 DSH 的 `${DSH_HOME:-$HOME/.dsh}`
    约定改为 `~/.dsh`。
  - 补齐真实磁盘布局下的树路由端到端测试（此前 0 覆盖，以上问题全部漏网）。
- 在线抓取的价目条目过 `sanitizeRates`：缺省桶（如官方页没有的 `cacheWrite`）继承
  内置价，而不是静默按 0 元计。
- `listWorkspaceSessions` 只解压日志首帧读头部，不再为读 200 字节的头整本解压。

## 0.1.0 — 2026-09-10

首个版本。

**功能**

- 在输入框下方的统计行内，加一枚与官方统计 pill 同款风格的「本会话 API 费用」胶囊：
  显示费用、账户余额与缓存命中率，点击向上展开明细面板。
- 费用来自官方 `sessionProjections` 投影（`costPill` 键），按每条 provider 上报的
  `assistant/message` usage 样本折叠，按样本时间归属高峰/空闲时段分别计价。
- 账户余额来自宿主侧 **loopback-only** 精确路由 `/api/cost-pill/balance`，走提供商
  自己的 `GET /user/balance`；API Key 只在宿主进程内解析使用，不下发浏览器、不落盘。
- 面板内容：计费时段、四个 token 桶、高峰/空闲金额、缓存命中率、账户余额（含充值/
  赠送拆分与手动刷新）、分模型明细、单价表与核验日期。
- 内置价目逐条核对自官方定价页（核对于 2026-09-10），并有「价格门禁」单测防止被
  无意改动；`pricing` 配置可覆盖任意模型（支持完整 `provider/model` 键与最长前缀匹配）。

**兼容性**

- 在 DSH `0.1.5-rc.1` 上验证（客户端与宿主两侧）。
- 合并进官方统计行依赖官方自带的 `data-composer-stats` 属性；该属性不存在时自动降级
  为独占一行的居中布局，功能不受影响。

**已知限制**

- 不做跨调价的历史分段：历史样本一律按当前价目重算。
- 未提供设置卡片：价格覆盖与余额阈值通过插件行 `config` 配置。
- 金额为估算值（中转折扣、赠送额度、按小时计费的缓存存储无法从会话 token 推算）。
