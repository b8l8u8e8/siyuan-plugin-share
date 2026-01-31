# GitHub Codespaces 部署指南

本文档介绍如何使用 GitHub Codespaces 快速部署和测试思源笔记分享服务。

## 📋 什么是 Codespaces？

GitHub Codespaces 是一个基于云的开发环境，可以让你在浏览器中直接运行和测试代码，无需在本地安装任何软件。

## 🚀 快速开始

### 1. 创建 Codespace

1. 打开本仓库的 GitHub 页面
2. 点击绿色的 `Code` 按钮
3. 选择 `Codespaces` 标签
4. 点击 `Create codespace on main` (或其他分支)

### 2. 等待环境初始化

Codespace 创建后会自动：
- 构建 Docker 镜像
- 启动 PHP Web 服务器
- 初始化数据库和文件目录
- 配置所需的环境

初次创建需要 2-3 分钟，请耐心等待。

### 3. 访问应用

当 Codespace 准备就绪后：

1. 在 VS Code 的 `PORTS` 面板中，你会看到端口 `8080` 已被转发
2. 点击端口 `8080` 旁边的 **🌐 地球图标** 或 **在浏览器中打开** 链接
3. 浏览器会打开一个新标签页，显示应用界面

**默认管理员账号：**
- 用户名: `admin`
- 密码: `123456` (首次登录会要求修改密码)

## 📁 项目结构

```
.
├── .devcontainer/
│   └── devcontainer.json     # Codespaces 配置文件
├── php-site/
│   ├── config.php            # 应用配置文件（已自动创建）
│   ├── storage/              # 数据库存储目录（自动创建）
│   ├── uploads/              # 用户上传文件目录（自动创建）
│   └── ...
├── docker-compose.yml        # Docker Compose 配置
└── README_CODESPACES.md      # 本文档
```

## 🔧 常用操作

### 查看服务状态

在 Codespace 的终端中运行：

```bash
docker-compose ps
```

### 查看服务日志

```bash
docker-compose logs -f
```

### 重启服务

```bash
docker-compose restart
```

### 停止服务

```bash
docker-compose stop
```

### 重新启动服务

```bash
docker-compose up -d
```

## 📝 配置说明

应用的配置文件位于 `php-site/config.php`，你可以根据需要修改：

- `app_name`: 应用名称
- `allow_registration`: 是否允许注册（默认 `true`）
- `default_storage_limit_mb`: 默认存储限制（MB）
- 其他配置项详见文件内注释

修改配置后需要重启服务才能生效：

```bash
docker-compose restart
```

## 🌐 访问权限

**重要：** Codespaces 中的端口转发默认是 **私有** 的，只有你自己可以访问。

如果你想让其他人访问你的 Codespace 应用：

1. 进入 `PORTS` 面板
2. 右键点击端口 `8080`
3. 选择 `Port Visibility` → `Public`

**注意：** 公开端口后，任何知道 URL 的人都可以访问你的应用。使用完毕后建议改回私有或删除 Codespace。

## 💾 数据持久化

Codespace 中的数据存储在以下位置：

- **数据库**: `php-site/storage/app.db`
- **上传文件**: `php-site/uploads/`

这些目录通过 Docker volumes 持久化，即使重启容器数据也不会丢失。

**注意：** 当你删除 Codespace 时，这些数据也会被删除。如果需要保存数据，请在删除前备份。

### 备份数据

```bash
# 在 Codespace 终端中运行
tar -czf backup-$(date +%Y%m%d).tar.gz php-site/storage php-site/uploads
```

然后可以通过 VS Code 的文件资源管理器下载备份文件。

## 🐛 故障排查

### 服务无法启动

1. 检查 Docker 服务状态：
   ```bash
   docker-compose ps
   ```

2. 查看详细日志：
   ```bash
   docker-compose logs -f web
   ```

### 无法访问应用

1. 确认端口已正确转发：
   - 打开 `PORTS` 面板
   - 确认端口 `8080` 显示为绿色（正在运行）

2. 检查防火墙设置：
   - 确认端口可见性设置正确

3. 尝试重启服务：
   ```bash
   docker-compose restart
   ```

### 数据库或上传目录权限问题

```bash
# 进入容器
docker-compose exec web bash

# 检查和修复权限
chown -R www-data:www-data /var/www/html/storage
chown -R www-data:www-data /var/www/html/uploads
chmod -R 775 /var/www/html/storage
chmod -R 775 /var/www/html/uploads
```

## 💡 开发技巧

### 修改代码并实时查看效果

1. 在 VS Code 中直接编辑 PHP 文件
2. 刷新浏览器即可看到更改（PHP 代码无需重启服务）
3. 如果修改了配置文件，需要重启服务

### 查看 PHP 错误日志

```bash
docker-compose exec web tail -f /var/log/apache2/error.log
```

### 进入容器调试

```bash
docker-compose exec web bash
```

## 📊 性能与限制

- **CPU**: 2-4 核心（根据你的 GitHub 账户类型）
- **内存**: 4-8 GB
- **存储**: 32 GB
- **网络**: 良好的国际网络连接

**注意：** Codespace 有使用时长限制，免费账户每月 120 核心小时。使用完毕后请及时停止或删除 Codespace。

## 🔗 相关链接

- [GitHub Codespaces 官方文档](https://docs.github.com/en/codespaces)
- [Docker Compose 文档](https://docs.docker.com/compose/)
- [项目 README](README_zh_CN.md)
- [Docker 部署指南](README_DOCKER.md)

## ❓ 常见问题

**Q: Codespace 会自动停止吗？**  
A: 是的，30 分钟不活动后会自动停止。你可以随时重新启动。

**Q: 数据会丢失吗？**  
A: 停止 Codespace 不会丢失数据，但删除 Codespace 会。请在删除前备份重要数据。

**Q: 可以在手机上使用吗？**  
A: 可以，Codespaces 支持移动浏览器，但体验可能不如桌面端。

**Q: 如何提高性能？**  
A: 可以在创建 Codespace 时选择更强大的机器类型（需要付费账户）。

**Q: 能否连接到生产数据库？**  
A: 不建议。Codespaces 适合开发和测试，生产环境请使用专门的服务器。
