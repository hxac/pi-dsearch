# pi-dsearch

|工具|Endpoint|Tool call 格式|
|-|-|-|
|`web_search` 搜索网页|`POST https://api.deepseek.com/v1/tools/search`|`web_search(query="...", count=10, ori_question="...", need_content=false)`|
|`web_fetch` 抓取网页正文（Markdown）|`POST https://api.deepseek.com/v1/tools/fetch`|`web_fetch(url="https://...", maxChars=20000)`|

## 安装

```bash
git clone https://github.com/hxac/pi-dsearch ~/.pi/agent/extensions/pi-dsearch
```

或者直接对 agent 说：

```
帮我安装 https://github.com/hxac/pi-dsearch
```

## 密钥配置



扩展会自动使用 pi 中已配置的 DeepSeek 密钥：

```
/login deepseek
```



## 使用

`web_search` / `web_fetch` 默认隐藏，用 `/ds` 唤醒并在本会话常驻：

```
/ds DeepSeek V4 发布        # 搜索
/ds https://example.com     # 抓取
/ds                         # 切换开关，已开启再执行一次关闭
```

## 参考文档

* https://api-docs.deepseek.com/zh-cn/guides/search

