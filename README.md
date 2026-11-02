# ZXJ Video V4 (Electron + better-sqlite3)

扫码枪监听软件，记录每次扫码的单号与时间，支持查询、导出 CSV 与按扫码触发海康录像截取。

## 开发环境
- Node.js 20/22（建议 22；不要用过新的 Node，原生模块可能没有对应预编译包）
- npm
- Windows 本机打包（better-sqlite3 / serialport 为原生模块，需在本机安装）

## 本地运行
```bash
npm install
npm start
```

> 若 `npm install` 下载原生模块超时，可使用国内镜像：
> PowerShell: `$env:npm_config_better_sqlite3_binary_host="https://registry.npmmirror.com/-/binary/better-sqlite3"`
> 之后再执行 `npm install`。

## 打包 Windows
```bash
npm run build:win
```

说明：
- 输出在 `dist/` 目录（NSIS 安装包 + portable）
- 原生模块（better-sqlite3、serialport）已通过 `asarUnpack` 解包，安装版可直接使用 USB 串口模式

## 数据库存储
- 使用 better-sqlite3（WAL 模式），数据库文件：`%APPDATA%\zxj-video-v4\records.db`（与旧版路径一致，升级后数据自动延续）
- 旧版 sql.js 产生的数据库文件为标准 SQLite 格式，**升级后可直接打开，无需迁移**
- WAL 增量写盘：每次扫码/状态更新均为增量落盘，不再全量重写文件

## 日志
- 日志按天写入 `%APPDATA%\zxj-video-v4\logs\app-YYYY-MM-DD.log`，**长期保留、不自动删除**
- 关键日志：`[SCAN]`（每次扫码）、`[TCP Server]`（连接/未知设备）、`[Watchdog]`（链路异常）、`[VideoDownload]`（录像触发）
- 排查"扫码没记录"时优先翻日志：有 `[SCAN]` 说明数据已入库，没有则查网络/TCP 层
- 日志量估算：每万次扫码约几 MB，长期积累也不占空间；如需清理，直接删除 `logs` 目录下旧文件即可

## 链路健壮性
- TCP KeepAlive：拔线/断电约 1~2 分钟内可感知断链，首页显示红色告警条
- 看门狗：已连接但超过 10 分钟无数据标记"链路异常"；超过 30 分钟主动断开等待扫码枪重连
- 编辑工作台配置（改名字/通道等）不再断开正在收数的连接；只有更换 IP/类型或启停才会重建连接
- 工作台标识支持网段匹配：`192.168.1.*` 可匹配该网段任意扫码枪
- 未知 IP 连接会被拒绝，并在首页与工作台页面显示提示

## 使用说明
- 扫码枪会以极快速度输入并以回车结束
- 输入间隔 < 50ms 且以回车结束会被判定为扫码（适用于旧版键盘模拟模式；当前 TCP/串口模式按行解析）
- 输入间隔 > 100ms 会清空缓存，忽略手动输入
- 建议扫码枪侧配置：静态 IP（或 DHCP 静态绑定）+ 后缀 CR/LF + 开启断线自动重连

## 调试
- 设置环境变量 `ZXJ_DEBUG=1` 后启动，会输出扫码原始数据与录像下载完整参数
