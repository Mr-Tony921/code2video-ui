# 真人广告与口播 skill 0.1.2

2026-11-26按用户确认固化，发行源码与最后D组实测包逐文件一致。目录`assets/c2v-human-video/releases/0.1.2/`不可原地修改；后续升级新建0.x版本。`manifest.json`固定文件SHA-256及实测ZIP哈希，重新打包可能改变ZIP容器哈希，文件内容必须一致。

## 挂载使用

通过dev Web实验模式上传自定义skill，内置skill选择`none`，沿用普通CC流程，不开启快速模式。将发行目录下的`c2v-human-video/`打包为ZIP，根目录须有`c2v-human-video/SKILL.md`。本次只归档源码，未新增普通C2V按钮，也不改变已有会话或服务默认值。

保持用户原prompt，在执行适配层明确要求先Read `.claude/skills/c2v-human-video/SKILL.md`再执行；原文与实际适配分别记录。最后实测还使用显式实验入口，不能将“上传成功”当作模型已经读取或流程合规。

依赖Python 3及Pillow、FFmpeg/ffprobe、Node22和已有`/opt/videokit` Canvas环境；浏览器录制另用现有Playwright/Puppeteer及`CHROME_BIN`。不要在模型任务中反复安装依赖。供应商配置由工具通过`C2V_MEDIA_CONFIG`或当前任务HOME下的`~/.config/c2v-media/.secrets`读取；模型名、网关、key由部署方私下配置，协议见包内`references/provider-config.md`。配置不进入ZIP、prompt或源码。新环境须核实注入与导出排除规则；clone源码不提供供应商访问权限。

## 工作流和验证边界

根据镜头与台词安排先图后视频、复用角色图、多段素材和代码图示／字幕，没有1图＋1视频或5分钟硬上限。每项素材有用途，同项最多一次有原因的替代；受理不明保留原回执续查，不盲目重提。

素材齐备后合成`output/final.mp4`，默认1280×720、24fps、H.264/yuv420p。初版后最多两次针对主要缺陷的局部修正，同问题不反复修；用户追问只改指定部分，复用其他素材。这些是skill约束，不宣称已经具备程序级返修计数器。

验证包括广告与口播、两模型4次真实成片的完整解码，素材工具串联／恢复／防重复回归，源码与实测包一致性及凭据排除。每组合仅一次，不是稳定生产通过率；自研广告仍有过多返修，产品外观保真、逐字台词及口型需人审。详细实验报告、过程轨迹与媒体保留私有runtime，不进入代码Git。
