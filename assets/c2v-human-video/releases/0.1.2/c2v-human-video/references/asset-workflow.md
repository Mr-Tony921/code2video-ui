# 多素材组合调用

先按 SKILL.md 用 `pipeline.py` 生成关键图与首段视频。其余镜头可以复用同一关键图；下面的数量只是单项调用示例，不限制总素材量。

```bash
python3 .claude/skills/c2v-human-video/scripts/media.py video \
  --prompt-file work/shot-02.txt --reference assets/generated/hero.png \
  --seconds 10 --resolution 720p --audio --out assets/generated/shot-02.mp4
```

需要不同构图时生成新关键图，再引用它生成新镜头：

```bash
python3 .claude/skills/c2v-human-video/scripts/media.py image \
  --prompt-file work/new-angle.txt --reference assets/generated/hero.png \
  --out assets/generated/new-angle.png
```

独立素材可在供应商并发允许时小批并行，人物/产品参考依赖必须等待上游就绪。具体数量由镜头计划决定，不为每段复制工具或重跑已经成功的首段链。

每条调用保存 prompt 与 receipt。成功文件复用；已受理用原命令续查，受理不明不盲目重提。pipeline失败后不要重新启动整链；核对 receipt 后续查已创建任务。质量替代需记录具体缺陷、原/新素材ID，并遵守每项一次针对性替代限制。配置由工具私下读取，计划不包含供应商型号或密钥。
