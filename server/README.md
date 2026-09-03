# 命理客户端 + Linux 服务器 部署说明

## 一、服务器端(Linux, 零第三方依赖)

要求：Node.js ≥ 22.5(自带 SQLite)。

1. 把 `server/` 目录拷到 Linux(如 `/opt/mingli-server`)。
2. 启动：
   ```bash
   cd /opt/mingli-server
   PORT=8787 node server.mjs
   ```
   - 数据目录默认 `server/data/mingli.sqlite3`(真 SQLite 文件)，可用 `DATA_DIR` 改。
   - 环境变量：`PORT`(默认 8787)、`HOST`(默认 0.0.0.0)、`DATA_DIR`、`ALLOW_REGISTER=false`(关闭开放注册)、`ADMIN_USER/ADMIN_PASSWORD`(预置管理员)。
3. 首个注册账号自动成为管理员；普通账号只能看到自己的记录；管理员可看全部并管理服务器 AI 配置。
4. AI 密钥只在服务器保存：管理员登录客户端 → 设置 → (服务器通道已登录) 可看到管理入口；或直接调接口 `POST /api/admin/config`。
5. systemd 常驻示例：
   ```ini
   [Unit]
   Description=mingli-server
   After=network.target
   [Service]
   WorkingDirectory=/opt/mingli-server
   ExecStart=/usr/bin/node server.mjs
   Environment=PORT=8787
   Restart=always
   [Install]
   WantedBy=multi-user.target
   ```
6. 防火墙放行端口；建议前端 https(nginx 反代)并把服务器地址填成 https 地址。

## 二、客户端(PWA / Windows)

客户端是同一份代码，默认行为：
- 未配置服务器 = 独立本地模式(自己排盘、本机离线保存；AI 可选手动填本机密钥直连)。
- 设置 → 服务器通道(默认)：填服务器地址并登录一次，本设备自动记住。
- 连得上服务器：记录自动汇总同步、AI 默认走服务器(不接触厂商)。
- 连不上服务器：自动退回本机离线数据 + 本机备用密钥直连分析；联网后自动补推/拉取。

PWA 打包：
```bash
cd client && npm install && npm run build   # 产物在 client/dist
```
把 `client/dist` 部署到任意静态 https 站点即可(已含 manifest/图标/离线 shell)。

## 三、接口速查(前缀 /api)
- auth: register/login/logout/me/password
- records: GET/POST /records, GET/PUT/DELETE /records/:id, POST /records/:id/ai/task, POST /records/:id/ai/cache-clear
- admin: GET /admin/records, GET+POST /admin/config, POST /admin/test
