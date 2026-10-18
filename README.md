# pi-dsearch

基于 [DeepSeek Search / Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search) 的网页搜索与抓取扩展。

| 接口 | Endpoint | 用途 |
|---|---|---|
| Search | `POST https://api.deepseek.com/v1/tools/search` | 按 query 搜索网页，返回结构化结果 |
| Fetch | `POST https://api.deepseek.com/v1/tools/fetch` | 抓取单个网页，返回 Markdown 正文 |

## 特性

- **两个工具**：`web_search`（搜索）、`web_fetch`（抓取单页正文）
- **会话开始时不可见**：两者注册时 `defaultActive: false`，不占用上下文
- **一个命令搞定**：`/ds`（唯一命令，没有其他快捷方式）
  - `/ds <搜索词>` 搜索并开启常驻
  - `/ds <http(s) URL>` 抓取并开启常驻
  - `/ds` 无参数 = 切换开关（**开启后再执行一次即关闭**）
- **常驻效果**：开启后 `web_search` + `web_fetch` 在本会话后续每个 run 都保持激活，模型可自行继续搜索/抓取
- **关闭可靠**：无参数 `/ds` 切换即立即从活跃工具集移除，并在下一次 run 开始前再次确认移除
- **恢复后仍生效**：`/tree`、`/resume` 之后由 `before_agent_start` 按开关重新同步工具集合
- **细节处理**：按 Unicode 码点截断（不会把 emoji 切成半个字符）；HTTP 错误按状态码给出可读提示（402 余额、403 安全策略、404 无正文、429 QPS 等）

> 常驻开关只保存在扩展实例内：重启 pi 或 reload 扩展后回到初始状态（不可见），再执行一次搜索/抓取即恢复常驻。

## 密钥来源

工具自动使用 pi 内置配置的 DeepSeek 密钥（`ctx.modelRegistry.getApiKeyForProvider("deepseek")`），按以下优先级解析：

1. `/login deepseek` 存入 `auth.json` 的密钥（含 `"!command"` 动态密钥）
2. 环境变量 `DEEPSEEK_API_KEY`
3. `models.json` 中 `deepseek` provider 的 `apiKey`

均未配置时回退直接读环境变量；都没有则提示先运行 `/login deepseek`。

## 使用

```bash
# 设置 API Key（DeepSeek 开放平台）
export DEEPSEEK_API_KEY=sk-xxx

# 开发调试：直接加载
pi --extension ./index.ts
```

在对话中输入：

```
/ds DeepSeek V4 模型发布                       # 搜索 + 开启常驻
/ds https://api-docs.deepseek.com/zh-cn/guides/search   # 抓取 + 开启常驻
/ds                                            # 切换：已开则关，已关则开
```

| 命令 | 作用 |
|---|---|
| `/ds <搜索词>` | 搜索并开启常驻 |
| `/ds <URL>` | 抓取并开启常驻（参数以 `http://`、`https://` 开头时） |
| `/ds` | 切换常驻开/关（再执行一次即关闭） |

## 工具参数

### `web_search`

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | 是 | 搜索词，1~128 个 Unicode 字符，支持下方操作符 |
| `count` | 否 | 返回条数 1~50，默认 10 |
| `ori_question` | 否 | 触发搜索的用户原始问题（≤128 字符），帮助理解搜索意图 |
| `need_content` | 否 | 是否在结果中返回网页正文，默认 `false`（每条正文截断到 4000 字符） |

### `web_fetch`

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | http/https、含 host、不带用户名密码，≤8192 字符 |
| `maxChars` | 否 | 返回正文的最大字符数，默认 20000，范围 1000~100000 |

## 搜索操作符（透传给 DeepSeek）

| 操作符 | 示例 | 说明 |
|---|---|---|
| `site:` | `pi site:github.com` | 限定站点，多个用空格分隔并加 `OR` |
| `-site:` | `pi -site:example.com` | 排除站点 |
| `-` | `pi -广告` | 排除关键词 |
| `-"..."` | `pi -"release notes"` | 排除精确短语 |
| `"..."` | `pi "精确短语"` | 精确短语匹配 |
| `lang:` | `pi lang:zh,en` | 限定语言 |
| `after:` / `before:` | `pi after:2025-01-01` | 限定发布时间 |

## 计费与限速

- 按**成功请求**次数计费，与返回条数无关：Search、Fetch 各 5 元 / 1000 次
- 失败、搜索无结果、超时不计费
- 每账号 Search 与 Fetch 分别限速 5 QPS，互不占用；Fetch 另有按目标域名的限速
- 超过限速返回 HTTP 429，建议等待后重试

## 错误码

| HTTP | 含义 |
|---|---|
| 400 | 请求头/请求体不合法（含字段值无效） |
| 401 | API Key 缺失或无效 |
| 402 | 账号余额不足 |
| 403 | Fetch 被安全策略拒绝 |
| 404 | Fetch 未能获取可用正文（URL 不可用、被站点拦截、内容类型不支持等） |
| 408 / 5xx | 超时或服务端错误，可重试 |
| 429 | 超过 QPS 限制 |

## 安装

把本目录（或 `index.ts`）放入扩展目录即可：

- 用户级：`~/.pi/agent/extensions/pi-dsearch/`
- 项目级：`<项目>/.pi/extensions/pi-dsearch/`

## Windows / Git Bash

Git Bash（MSYS）在调用原生 Windows 程序前，会把以 `/` 开头的参数改写为绝对路径（`/ds 测试` → `C:/Program Files/Git/ds 测试`）。

因此请先启动 `pi --extension ./index.ts`，再在对话输入框里输入 `/ds ...`；不要把它作为命令行位置参数传入。
