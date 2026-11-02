<div class="title" align=center>
    <img src="./logo.png" width="250">
    <br>
    <p>
        <img src="https://img.shields.io/badge/license-%20%20GNU%20GPLv3%20-orange?style=plastic">
        <img src="https://img.shields.io/badge/Google%20Chrome-4285F4?logo=GoogleChrome&logoColor=white">
        <img src="https://img.shields.io/github/stars/XJTU-WXY/BiliPurifier?style=social">
    </p>

</div>

## 🚩 简介
一个浏览器扩展，按标题、UP 主、分区与视频统计数据屏蔽 B 站视频推荐流，并在视频播放页按内容与评论者净化评论区。

本项目是在 [DemoJ/BiliBlock](https://github.com/DemoJ/BiliBlock) 的基础上开发的，感谢原作者提供的宝贵思路。

具有如下特性：
-  **按关键词 / 正则规则屏蔽：** 屏蔽命中规则的视频标题 / UP主 / 分区，为推荐流每张卡片的 UP 主昵称右侧添加快捷屏蔽按钮，点击即可添加一条精确匹配该 UP 主的正则规则。
- **按统计数据条件屏蔽：** 可用逻辑表达式描述筛选条件，支持播放量、点赞量、弹幕量、回复量、收藏量的任意比例条件嵌套组合。
- **支持移除 / 占位两种屏蔽方式：** 可以将被屏蔽内容显示为占位符，点击即可恢复查看。
- **支持预加载：** 页面载入后把下方的推荐流内容提前加载并判定好。*（实验性功能）*
- **评论区净化：** 按评论内容和评论者昵称屏蔽评论，支持屏蔽含 @ 的评论。
- **配置文件备份与恢复：** 支持导出导入配置文件，方便分享规则。

## 📥 安装

1. 打开 `chrome://extensions/`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择项目目录。
3. 点击插件栏图标，选择「编辑规则」进入设置页。

## 🔑 使用说明

屏蔽规则一行一条，默认为关键词匹配，若该行以`/.../`包裹则视为正则规则，一些例子：
- `局势升级`：一条关键词匹配，所有含有“局势升级”的内容都会被屏蔽。
- `/世界$/`：一条正则匹配，以“世界”结尾的内容会被屏蔽。
- `/局势升级|突发|最新消息|全网叫好|重磅|刚刚/`：一条正则匹配，命中任意关键词都会屏蔽，本质上相当于把这些关键词拆成多行写，但这样写更简洁，方便分组。


## ⚖ 开源协议
本项目基于 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html) 开源.
  
*Open source leads the world to a brighter future!*