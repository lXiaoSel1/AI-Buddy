# 全角色桌宠与表情 / Character pets and expressions

1.7.8 的角色包括 DeepSeek、Claude、Grok、Seed、Kimi、Qwen、MiniMax、GPT、Gemini、GLM、混元。每位拥有 18 个独立动作，待机、挥手、开心分别使用自己的视频；审查中和认真也分别制作。

## 选择桌宠

打开“通用设置 → 桌宠”：

- **跟随 Galgame 角色**：使用 Galgame 最终选中的角色，包括手动选择和模型跟随结果。
- **固定角色**：指定一位桌宠，切换 Galgame 不会改变它。设置在重启后保留。

聊天 API 与形象独立。Qwen 形象使用 Claude API 聊天时，跟随模式仍显示 Qwen。固定 Claude 时，它仍响应聊天已经解析的情绪并显示原回复气泡，不加角色名前缀，也不会为换动作再次请求模型。

切换会先加载目标角色。拖动、手动演示或任务反馈正在进行时，等待结束后切换；连续选择只采用最后一个目标。加载失败时保留当前桌宠并显示提示。

## 动作展示

顶部角色选择器只改变浏览对象，不修改桌宠设置。每位显示待机、左右移动、挥手、跳跃、失败、等待用户、工作中、审查中、看向鼠标，以及八种情绪。统一按钮控制预览暂停和播放。

点击“在桌宠播放”会临时展示该角色及动作。演示结束或离开动作页后，恢复跟随或固定设置。任务完成仍播放两轮跳跃，失败播放一轮，气泡与动作一起排队。

## Galgame 表情

新增的十位角色各有八张已批准的表情立绘；DeepSeek 保留原表情。普通状态使用角色普通立绘，加载失败回到同角色普通立绘。用户自定义立绘优先，手动显隐和“CG 背景隐藏立绘”继续生效。多人剧场使用各发言者已有的情绪标签。

## English

Open **General settings → Desktop pet** and choose **Follow Galgame character** or **Fixed character**. The saved choice survives restarts. Appearance and the chat API are independent. Changing the API does not automatically replace a manually selected Galgame character.

Each of the eleven characters has eighteen separate actions. Idle, greeting wave, and happiness use different videos; reviewing and seriousness also have separate animations. Completion plays two jumps; failure plays once. Text and animation stay together in the feedback queue.

The character selector on the action gallery changes only the preview. **Play on desktop pet** temporarily demonstrates that character and action, then restores the saved selection when the demonstration ends or you leave the page. Pending task feedback is preserved.

Ten characters gain eight approved portrait expressions each; DeepSeek keeps its existing set. Custom portraits take priority. Manual portrait visibility and hiding portraits over CG backgrounds continue to work. No extra model request is made to change a portrait or pet emotion.

Runtime animation files are transparent VP9 WebM at 30 or 60 fps. Cursor directions and 80 portrait expressions use WebP Q95 with unchanged alpha; reduced-motion peak stills remain lossless. Production sources, rejected candidates, and processing checkpoints remain outside the portable package. Both editions share code and save format. The default scale is 125%; valid saved scale settings are preserved.
