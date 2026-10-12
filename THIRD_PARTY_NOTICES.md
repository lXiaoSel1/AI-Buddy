# Third-party code, artwork and runtime notices

AI Buddy is adapted from [JAdpp/dsh-whale-galgame](https://github.com/JAdpp/dsh-whale-galgame), pinned at `046b848f244450e6e636335766276bf3343fe84b`. Adaptations include the Electron host, independent model/image connections, persistence, monitoring and UI. Thank you to JAdpp and all upstream contributors.

Original notices are preserved under [licenses/upstream](licenses/upstream/): code/UI/docs are MIT, while the upstream image terms differ. The upstream table identifies 21 default images under CC BY-NC-SA 4.0 and a desktop-pet atlas under MIT. The code license does not relicense character artwork.

## Character provenance

- [上善](https://www.pixiv.net/users/62155430): original character author in the upstream attribution chain.
- [ZipZipPipe](https://www.pixiv.net/users/18604994): DeepSeek maid redesign and AI character references; [gallery](https://genderswapai.com/zh-CN/ai-gijinka/gallery).
- [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale): maid atelier art/backgrounds and notices.
- [f0909172434/dsh-deepseek-girl-pet](https://github.com/f0909172434/dsh-deepseek-girl-pet): original pet assets.

DeepSeek uses the confirmed character reference, original expression/background assets and generated complete-character animation. MiniMax H3 generated the motion videos, with RIFE interpolation and approved 60fps sampling. These tools are development-time only. This notice does not claim a blanket MIT license for the generated character derivatives.

The ten new portraits/backgrounds (Grok, Seed, Kimi, Qwen, MiniMax, GPT, Gemini, Claude, GLM, Hunyuan) were generated using the built-in image tool with selected gallery character designs as references. The generated pixels are not the original gallery files. The underlying character design authors remain credited; a general redistribution license for all ten references has not been verified. Keep this distinction when reviewing a public release or commercial use. Asset hashes and reference-gallery metadata are included in the release resource manifest.

README screenshots are captures of the actual application with an independent test profile. CG examples are saved development validation images. They are not screenshots of the developer's personal conversations or monitored work.

## Monitoring and prices

- [ccusage](https://github.com/ccusage/ccusage), MIT, pinned `b4507e731b318c5a954c448db6602dc8241b7571`: parsing boundaries, report organization and development cross-checks. Not a runtime dependency.
- [CodexBar](https://github.com/steipete/CodexBar), MIT, pinned `79831b47517f3e3e340886be63157f582ab13d41`: quota protocols, refresh/error behavior and provider separation. Windows implementation is adapted for this app.
- [models.dev](https://models.dev), public model price catalog: bundled offline snapshot and optional updates. Estimates are references, not invoices. See `licenses/monitor`.

## Runtime and tools

[Electron](https://www.electronjs.org/) 44.6.0 and Chromium licenses ship in the runtime folder. React 19.3.0, React DOM, scheduler and esbuild licenses ship in `licenses/`. Windows executable resources are branded with [rcedit](https://github.com/electron/rcedit) 2.0.0. [RIFE](https://github.com/hzwer/ECCV2022-RIFE) was used during motion production; Python, OpenCV, RIFE and video-generation models are not required by the distributed app.

AI Buddy is not an official product of the named AI providers or character artists. Service and model names identify compatibility and appearance choices.
