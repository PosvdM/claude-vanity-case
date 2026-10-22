# Agent 说明

## 文档

本项目的 README、技术文档、代码注释、提交信息、PR 描述和发布说明按 `project-docs` 规范编写。规范在线维护，不需要安装：

https://raw.githubusercontent.com/PosvdM/Skills/main/skills/project-docs/SKILL.md

- 在本次会话中第一次修改代码或上述文字前，读取这个文件的全文，不要只看摘要。同一会话中不必重复读取。
- 每次修改代码后、结束任务前，按该规范检查 README 和技术文档，更新受影响的内容。
- 无法访问该文件时告诉用户，并遵守以下要点：
  - README 写给使用者，实现细节写进技术文档；技术文档与 README 使用相同的语言和写作规范。
  - 文档只写当前状态，变更经过写进提交信息、PR 描述或发布说明。
  - 发现重复、过时或杂乱的内容时，精简整理。

## 测试

修改代码后运行 `npm test`。界面改动无法在测试里覆盖，需要用 `npm run dev` 启动后手工检查；不要拿自己的真实配置试，用 `CLAUDE_CONFIG_DIR` 和 `VANITY_CASE_DIR` 指向副本，做法见技术文档的"开发和测试"。
