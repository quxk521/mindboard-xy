# MindBoard

MindBoard 是一个本地优先的无限画板笔记软件，支持文本节点、图片节点、自由连线、分组、区域跳转和 Obsidian Canvas 文件转换。

## 在线使用

这个项目可以直接发布到 GitHub Pages，发布后打开网页即可使用：

```text
https://你的用户名.github.io/你的仓库名/
```

在线版数据默认保存在当前浏览器的 IndexedDB 中，不会自动上传到 GitHub，也不会跨设备同步。重要画板请定期使用“导出 mindboard”备份。

### 发布到 GitHub Pages

1. 新建 GitHub 仓库，例如 `mindboard`。
2. 上传本项目文件，注意不要上传 `node_modules` 和 `dist`。
3. 打开仓库 `Settings -> Pages`。
4. 在 `Build and deployment` 中选择 `GitHub Actions`。
5. 推送到 `main` 或 `master` 分支后，`.github/workflows/deploy-pages.yml` 会自动发布网页。
6. 发布完成后，在 GitHub Actions 或 Pages 设置页查看访问地址。

## 本地网页预览

```powershell
cd C:\Users\topxy\Documents\ai\mindboard_desktop
npm.cmd run serve
```

然后打开：

```text
http://127.0.0.1:5177/
```

## 桌面版运行

先安装依赖：

```powershell
cd C:\Users\topxy\Documents\ai\mindboard_desktop
npm.cmd install
```

启动桌面版：

```powershell
npm.cmd run dev
```

如果 Electron 下载很慢，可以设置镜像后重新安装依赖。

## 功能

- 无限画布、滚轮缩放、拖拽平移。
- 文本节点、图片节点、网页链接节点、分组。
- 节点四向连接点，拖到空白处可新建节点，拖到其他节点连接点可连线。
- 双击连线可添加或编辑说明。
- 图片选择、拖入图片、粘贴图片。
- 粘贴文本自动创建文本节点。
- 图片等比例缩放，支持拖动边框裁剪。
- 节点重叠时，点击选中节点会自动置顶。
- 左侧工具栏可显示或隐藏网格。
- 区域跳转：框选画布区域后，可绑定到 3x3 跳转控件。
- 撤销、重做、自动保存、导入和导出 `.mindboard`。

## 在线版限制

- 数据保存在当前浏览器本地，不是云同步。
- 换电脑或换浏览器不会自动带走数据。
- 清理浏览器站点数据可能删除画板。
- GitHub Pages 是静态托管，不能直接提供多人协作。
- 如果需要跨设备同步，需要后续接入云端服务。

## Obsidian Canvas 转换

图形界面转换器：

```powershell
npm.cmd run converter:dev
```

命令行转换：

```powershell
npm.cmd run convert:obsidian -- "C:\你的Obsidian库\画板.canvas" --vault "C:\你的Obsidian库"
```

指定输出文件：

```powershell
npm.cmd run convert:obsidian -- "C:\你的Obsidian库\画板.canvas" "C:\Temp\画板.mindboard" --vault "C:\你的Obsidian库"
```

转换后在 MindBoard 中选择“导入 mindboard”即可使用。
