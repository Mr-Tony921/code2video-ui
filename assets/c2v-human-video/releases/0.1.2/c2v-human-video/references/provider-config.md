# 私有配置契约

部署方将以下结构写入受保护且不参与导出的文件，通过 `C2V_MEDIA_CONFIG` 指定，或放在模型运行用户的 `~/.config/c2v-media/.secrets`。每个任务只提供必要的两个渠道，不复制完整账户密钥表。文件权限建议 0600。

```json
{
  "image": {
    "base_url": "https://<authorized-provider>",
    "path": "/v1/images/generations",
    "model": "<configured-image-route>",
    "api_key": "<private-runtime-value>"
  },
  "video": {
    "base_url": "https://<authorized-provider>",
    "path": "/volces/api/v3/contents/generations/tasks",
    "model": "<configured-video-route>",
    "api_key": "<private-runtime-value>"
  }
}
```

这是当前工具支持的同步图片 / 异步视频协议；换网关时须按其官方文档改 adapter，不能只替换模型名并假定任意 API 兼容。配置文件、API header、环境变量和 key 不进入 prompt、SKILL.md、代码 ZIP、普通日志或可下载工作区。

导出方必须显式排除该配置文件；不能假定整个 `.home` 都被排除。当前 dev 导出器按文件名排除 `.secrets`，所以采用该文件名；换环境必须验证相应导出规则。工具不会自动修改服务器权限或分享配置。素材回执中保留供应商任务 ID 和结果 URL 便于恢复；对外共享源码时可只保留任务 ID/文件哈希，清除已过期的签名 URL。
