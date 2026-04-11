# ZXJ Video V4 (Electron + sql.js)

扫码枪监听软件，记录每次扫码的单号与时间，支持查询与导出 CSV。

## 开发环境
- Node.js 18+（建议）
- npm
- macOS / Windows 均可运行（打包 Windows 建议在 Mac 上使用 electron-builder）

## 本地运行
```bash
npm install
npm start
```

## 打包 Windows
```bash
npm run build:win
```

说明：
- 输出在 `dist/` 目录
- 如果在 Mac 上打包 NSIS 失败，通常需要安装 `wine`（用于生成 Windows 安装包）

## 数据库存储
- 使用 `sql.js`，数据库文件保存到 `app.getPath('userData')/records.db`
- 启动时自动加载，写入后立即持久化

## 使用说明
- 扫码枪会以极快速度输入并以回车结束
- 输入间隔 < 50ms 且以回车结束会被判定为扫码
- 输入间隔 > 100ms 会清空缓存，忽略手动输入
