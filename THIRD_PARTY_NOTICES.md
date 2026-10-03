# Third-Party Notices

本仓库（`dsh_feiyu`）是 DeepSeek Harness 的**纯客户端插件**，只包含插件代码与派生动画素材。
插件代码以根目录 [`LICENSE`](LICENSE)（MIT）发布；**下列素材不受 MIT 覆盖**。

---

## 1. 角色动画素材（webm / 内联静态帧）

- **Files**：
  - `assets/*.webm`（14 段，640×360 / 24fps / VP9-alpha 透明视频）
  - `assets/clips.json`（随附的播放描述；其中的 `idle_poster` 是内联的待机静态帧）
- **Origin / Source Repository**：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
  （动作素材做法与素材来源；本项目经整理搬运）
- **Notes**：角色 OC「溟月」出自画师上善无形，素材由社区成员整理制作。
  此类同人素材按 CC BY-NC-SA 类条款发布，**仅限个人非商业使用**，
  使用须保留署名与来源，不得用于任何商业/盈利场景。
- **本仓库做的加工**：`assets/*.webm` 是从上游素材中精选的 14 段（原样复制、未重新编码），
  `clips.json` 为播放描述；待机静态帧由上游片段经 ffmpeg `libvpx-vp9` 抽帧后内联为 data URL，
  以避免额外图片请求。重新生成素材的脚本见 [`tools/build_assets.py`](tools/build_assets.py)
  （**它需要上游的源素材目录，该目录不随本仓库分发**）。

---

## 2. 其余第三方组件

上游桌面版项目（[MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop)）还包含
DeepSeek 余额鲸鱼音效、lunar-python、节日文案库等组件。**这些均不属于本仓库**，
本仓库不复制、不依赖它们。
