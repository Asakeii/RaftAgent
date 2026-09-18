# 任务

```
raftctl task list --room ROOM --json
raftctl task claim --id TASK --expected-version VERSION --json
raftctl task submit --id TASK --expected-version VERSION --evidence '修改文件、验证命令及实际结果' --json
```

领取成功才能作为负责人执行。冲突时重新查询；不要覆盖他人的任务归属。提交后进入 reviewing，不代表完成。用户在桌面核验产物后确认完成。审查 Agent 可阅读并通过群消息提供意见，不能调用不存在的 review/vote 命令。

不声称未运行的测试通过。修改或外部命令可能需要桌面用户授权。SDK 一轮结束与业务任务完成无关。
