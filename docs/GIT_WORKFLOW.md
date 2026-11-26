# Git 使用步骤

当前项目目录：`/mnt/afs_if/codevideo/workspace/code2video-dev-codex`。公开仓库：`https://github.com/Mr-Tony921/code2video-ui.git`。下载不需要账号或邀请；所有者推送继续使用现有 SSH remote。
署名 Tony <tongronglei@163.com> 只设置在本仓库，不修改全局 Git 配置。

## 当前基线

- `main`：当前开发版本。
- `v1.4.6-codex.1`：首次接手、复现与精简重构完成后的基线。
- `v1.5.0`：统一版本号并纳入 Git 的发布版本。

## 下载与权限

```bash
git clone https://github.com/Mr-Tony921/code2video-ui.git
```

`main-owner-only` 为 Active，只匹配 `main`；Restrict updates / deletions、Require linear history、Block force pushes 均启用，仅 `Mr-Tony921` 可绕过。未添加协作者写权限；以下提交步骤仅供所有者执行。下载者可在自己的副本修改，不能直接更新本仓库的 main。

## 平时开发

```bash
cd /mnt/afs_if/codevideo/workspace/code2video-dev-codex
git switch main
git pull --ff-only
# 修改代码后运行相应验证
git status
git diff
git add <本次修改的文件>
git diff --cached
git commit -m "feat: describe the change"
git push origin main
```

按用户要求只维护 main，直接在线性历史上提交，不新建功能分支或 worktree，不创建合并提交。仓库本地 pull.ff=only；若拉取不能快进，先检查双方改动，不强推覆盖。部署仍使用本副本的隔离校验；只改白模 Python host 时，新白模任务启动会读取并快照新文件，在飞任务继续原快照，不需要重启 C2V/实验模式。

## 发布版本

修改根 VERSION、三个应用的 package.json 及 Web package-lock.json 根包版本，添加 CHANGELOG。
前端版本在构建期注入，Gateway/Bridge 从 VERSION 读取，因此需要重新构建前端并更新本副本服务。
验证通过后提交、创建附注标签，再将 main 与该标签一起推送；示例：

```bash
git add VERSION CHANGELOG.md apps/
git commit -m "chore: release version 1.5.1"
git tag -a v1.5.1 -m "Code2Video 1.5.1"
git push --atomic origin main v1.5.1
```

不要为查看旧版本直接切换正在运行的工作区；可以先用 `git show v1.5.0:VERSION` 或 `git diff v1.4.6-codex.1 v1.5.0` 查看。

## 本地配置与凭据

实际 `config/backend.json`、runtime/、.env、依赖和构建产物均被忽略。仓库提交的是脱敏的 backend.example.json。
新 clone 后先复制模板，再设置独立部署的路径/端口/模型，并在 runtime/.secrets 配置需要的密钥；不要覆盖已有运行配置。
SSH 私钥保存在当前机器的本地文档目录下，Git 的 core.sshCommand 只在此仓库引用它，不会上传。
公开源码可直接用 HTTPS clone，无需复制所有者的 SSH 密钥。只有需要以所有者身份推送时，才配置该机器自己的授权密钥。
