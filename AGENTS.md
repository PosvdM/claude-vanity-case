# Agent 说明

## 文档

本项目的文档和其他项目文字按 `project-docs` 规范编写，适用范围以规范为准。每个会话第一次修改代码，或编写文档、代码注释、提交信息、PR、发布说明等文字前，读取规范全文：本机已安装 `project-docs` skill 时加载本机版本，否则读取 https://raw.githubusercontent.com/PosvdM/Skills/main/skills/project-docs/SKILL.md 。两处都读不到时告诉用户。

## 测试

修改代码后运行 `npm test`。界面改动无法在测试里覆盖，需要用 `npm run dev` 启动后手工检查；不要拿自己的真实配置试，用 `CLAUDE_CONFIG_DIR` 和 `VANITY_CASE_DIR` 指向副本，做法见技术文档的"开发和测试"。
