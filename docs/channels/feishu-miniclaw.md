---
summary: "Standalone MiniClaw C integration guide for Feishu bot access"
read_when:
  - You are implementing Feishu bot support in MiniClaw
  - You need a standalone document without source-code references
title: Feishu MiniClaw Integration
---

# MiniClaw 接入飞书 Bot 实施指南

这份文档面向 `MiniClaw` 的 C 开发团队，目标是提供一份可以直接落地的飞书 Bot 接入方案。  
文档包含模式选择、配置模板、事件处理、消息收发、媒体能力、安全要求和验收清单。

## 目标和范围

目标：

1. 让 MiniClaw 能接收飞书消息并调用本地 Agent 生成回复。
2. 支持文本、回复、媒体附件三类基础能力。
3. 在默认安全配置下可稳定运行，支持后续扩展。

当前范围：

1. 飞书消息接入（WebSocket 长连接或 webhook）。
2. 入站消息标准化、鉴权策略、去重处理。
3. 出站文本和媒体发送。
4. 线程回复和基础运维排障。

## 接入模式选择

推荐优先级：

1. `WebSocket 长连接`（默认）
2. `webhook`（仅在你明确需要时使用）

模式对比：

| 模式 | 适用场景 | 关键要求 |
| --- | --- | --- |
| WebSocket 长连接 | 希望不暴露公网回调地址 | 飞书后台开启 long connection 订阅 |
| webhook | 已有稳定公网入口和反向代理体系 | 必须配置 `verification_token`，并做好限流和请求体保护 |

## 飞书平台准备

1. 在飞书开放平台创建企业自建应用。
2. 启用 Bot 能力并设置机器人名称。
3. 记录 `App ID` 和 `App Secret`。
4. 配置事件订阅：
   - 必选事件：`im.message.receive_v1`
   - 可选事件：`im.message.reaction.created_v1`、`card.action.trigger`
5. 按需申请权限（建议最小集）：
   - 消息读取
   - Bot 发消息
   - 消息资源下载
   - 群成员读取（如需成员识别）
   - 卡片写入（如需卡片消息）

## MiniClaw 配置模板

建议定义统一配置（JSON 示例）：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "domain": "feishu",
      "connection_mode": "websocket",
      "app_id": "cli_xxx",
      "app_secret": "xxxxxx",
      "encrypt_key": "",
      "verification_token": "",
      "webhook": {
        "host": "127.0.0.1",
        "port": 3000,
        "path": "/feishu/events"
      },
      "policy": {
        "dm_policy": "pairing",
        "group_policy": "allowlist",
        "require_mention": true
      },
      "limits": {
        "text_chunk_limit": 4000,
        "media_max_mb": 30
      }
    }
  }
}
```

字段建议：

1. `connection_mode` 默认 `websocket`。
2. `verification_token` 仅 `webhook` 模式必填。
3. `webhook.host` 默认 `127.0.0.1`，除非明确需要对外监听，否则不要改成 `0.0.0.0`。
4. `group_policy` 建议默认 `allowlist`，避免群内误触发。
5. `require_mention` 建议默认 `true`，降低噪音触发。

## C 工程模块拆分建议

推荐最小模块：

1. `feishu_config.c/.h`：配置加载和校验。
2. `feishu_auth.c/.h`：Token 获取与刷新。
3. `feishu_ws.c/.h`：长连接建立与重连。
4. `feishu_webhook.c/.h`：HTTP 回调接入。
5. `feishu_events.c/.h`：事件路由分发。
6. `feishu_inbound.c/.h`：入站消息标准化和策略判断。
7. `feishu_send.c/.h`：文本/回复发送。
8. `feishu_media.c/.h`：媒体上传下载。
9. `feishu_dedupe.c/.h`：去重缓存和持久化。
10. `feishu_policy.c/.h`：DM/群策略和 allowlist 判断。

## 启动流程

建议流程：

1. 读取配置并校验必填项。
2. 初始化日志、HTTP 客户端、JSON 解析器。
3. 预检 Bot 基本信息，拿到 `bot_open_id`（用于 @ 判定和事件过滤）。
4. 根据 `connection_mode` 启动接入层：
   - `websocket`：启动长连接事件循环
   - `webhook`：启动本地 HTTP Server
5. 进入事件处理主循环。

主循环伪代码：

```c
while (running) {
  FeishuEvent ev = feishu_next_event();
  if (!ev.valid) continue;

  if (dedupe_seen(ev.message_id)) continue;
  dedupe_record(ev.message_id);

  InboundMsg msg = normalize_event(ev, bot_open_id);
  if (!policy_allow(msg, config.policy)) continue;

  AgentRequest req = build_agent_request(msg);
  AgentReply reply = miniclaw_dispatch(req);

  feishu_send_reply(msg, reply);
}
```

## 入站处理规范

### 1. 统一消息模型

归一化后建议至少包含：

1. `message_id`
2. `chat_id`
3. `chat_type`（`p2p` 或 `group`）
4. `sender_open_id`（缺失时回退 `user_id`）
5. `content_type`
6. `content_text`
7. `parent_id`（回复目标）
8. `root_id`（话题根消息）
9. `mentions`
10. `create_time`

### 2. 去重机制

建议双层去重：

1. 内存去重：处理并发重复投递。
2. 持久化去重：重启或重连后防止重放。

建议默认值：

1. TTL：24 小时
2. 内存容量：1000 条
3. 持久化上限：10000 条

### 3. 策略判断

建议默认策略：

1. 私聊：`pairing`
2. 群聊：`allowlist + require_mention=true`

建议判断顺序：

1. 渠道是否启用
2. 群或私聊策略是否允许
3. 发送者是否在 allowlist
4. 群消息是否满足 @ 条件

### 4. 媒体入站

建议先支持这些类型：

1. `image`
2. `file`
3. `audio`
4. `video`
5. `post`（富文本内嵌媒体）

实现建议：

1. 文本与媒体分离处理。
2. 媒体按 `message_id + file_key` 拉取。
3. 下载后做 MIME 检测和大小限制，再落盘。

## 出站发送规范

### 1. 文本消息

建议优先使用支持 Markdown 的消息格式（如 `post` 或卡片），保证代码块、表格渲染稳定。

发送逻辑：

1. 普通发送：按 `chat_id` 或 `open_id` 创建消息。
2. 回复发送：若有 `reply_to_message_id`，走回复接口。
3. 线程回复：开启 `reply_in_thread` 时，回复进入话题线程。

### 2. 回复失败回退

当回复目标被撤回或不存在时，建议自动回退为普通发送，避免回复中断。

### 3. 媒体发送

建议流程：

1. 识别附件类型（图片或文件）
2. 先上传获取资源 key
3. 再发送媒体消息

默认限制建议：

1. 最大媒体大小：30 MB
2. 超限时返回用户可读错误

## webhook 模式安全要求

如果启用 webhook，建议强制这些守卫：

1. 仅允许 `application/json`。
2. 请求体大小上限 `1 MB`。
3. 请求体读取超时 `30 秒`。
4. 固定窗口限流。
5. 异常状态码计数并告警。
6. 默认只监听 `127.0.0.1`，外网入口由反向代理统一管控。

## 验收清单

联调完成前，至少通过以下用例：

1. 私聊文本可正常接收和回复。
2. 私聊未授权用户触发配对流程。
3. 群聊中 @Bot 可回复，未 @Bot 不回复。
4. 回复某条历史消息可成功关联。
5. 图片和文件可上传并发送。
6. 重启服务后不会重复处理旧消息。
7. 接入层异常重连后可恢复收发。

## 常见问题和排查

### 不收消息

1. 事件订阅未开启或缺少 `im.message.receive_v1`。
2. Bot 未被拉入目标会话。
3. 应用未发布或权限未审批通过。
4. 配置 `domain` 与租户环境不一致（`feishu` vs `lark`）。

### 能收不能发

1. 缺少发送权限。
2. `app_secret` 过期或错误。
3. 回复目标消息已撤回，且未做回退。

### 重复回复

1. 只有内存去重，没有持久化去重。
2. 去重键未包含 `message_id`。
3. 重连后历史事件回放未过滤。

## 建议的里程碑

1. M1：文本收发和基础策略。
2. M2：回复链路、线程回复、媒体收发。
3. M3：卡片流式输出、反应事件、观测和告警。

完成 M2 后即可满足多数生产场景。
