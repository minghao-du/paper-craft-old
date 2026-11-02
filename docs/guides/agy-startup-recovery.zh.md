# 诊断与恢复 agy 启动

[English](agy-startup-recovery.md)

先用本流程检查失败或待确认的托管启动，再选择手动恢复操作。[托管生命周期契约](../../skills/pc-orchestrator/managed-lifecycle.md)是初始化、权限、终止和释放的权威依据；[agy 流程](../../skills/pc-orchestrator/agy-interactive.md)定义提供方证据。本指南不授权恢复或科学计算执行。

## 定位任务归属

使用权威 Fleet 配置进行只读检查：

```sh
pc workflow orchestrator status --config /absolute/path/.epic-config.json
pc workflow orchestrator status --detailed --config /absolute/path/.epic-config.json
```

按仓库和 Issue 找到 Run，再定位其当前 Orchestrator 或子 Dispatch 及最新 Attempt。区分命令结果、Run 生命周期、Attempt 状态、`startupRecovery` 和 `activationStatus`。Run 正在运行本身不证明继续执行消息已送达。沿返回的 Evidence 和诊断路径检查；详细状态不会读取日志或转录。如果出现 `diagnosticSaveError`，保留已报告的业务结果，不要为修复日志而重复成功的工作。

在 Attempt 证据目录中，将保留的 `terminal.json` 和 `agy-native.json` 与选定 Attempt 及其记录的原生对话、终端地址、窗格/窗口和 Run 会话核对。沿原生回调的 `transcript_path` 找到原始转录。仅在归属已验证时检查记录的终端；仅在状态提供已验证可用终端时使用其 attach 命令。归属缺失或冲突属于阻塞，不能据此占用窗格。

## 确认失败的门槛

1. **提交输入与完成的原生回复。** 检查原始 `agy-input.txt`。在确切的原生对话中，要求存在匹配的 `USER_INPUT`，其 `source: USER_EXPLICIT`、`status: DONE`，随后存在包含确切角色/Attempt 就绪标记的已完成模型 `PLANNER_RESPONSE`。同时验证仍存活且归属正确的终端。可见标记、回调或最新回复本身不能满足归因要求。对于历史内联启动，保留原始保存输入；不得用短提示替换，也不得改写转录。历史输入缺失时保留运行时现有处理方式并报告缺失，不得合成证据。
2. **角色初始化事实。** 按托管生命周期契约中绑定任务的要求，将 `initialization.json` 和实际角色/项目状态与上下文哈希及当前权限一起核对。文件存在并不足够。按契约完成角色特定检查，不要复制其他 Attempt 的证据。即使原生就绪已确认，证据缺失或过期仍使启动保持待确认。
3. **独立激活与继续消息。** 检查属于此确切当前 Attempt 的已提交激活，以及独立继续输入的原生送达证据。就绪不代表任务验收，也不赋予调度权限。继续消息未确认时仍处于待确认状态，不要再次粘贴消息来消除不确定性。现有辅助进程通过确切原生输入协调，不会盲目重放。

对于新格式 Attempt，**当 `startup.md` 存在时**单独检查：它包含当前 Attempt 的完整启动指令，包括初始化和适用的协调指令。`agy-input.txt` 是实际提交、用于原生关联的短指针提示。原始任务/上下文文件仍是绑定哈希的任务证据，含义不变，不一定包含追加的初始化指令。核对身份及指针是否属于此 Attempt，并将缺失、不可读或不匹配的内容保留为诊断证据。不得覆盖或改用内联指令。历史 Attempt 无须具备此产物。

## 选择手动操作

采取任何操作前，检查持久化结果、不可变 Receipt、已接受确认、当前权限及资源归属。协调已接受的工作，不要重放。无论经过多久，占用情况未知的执行都保持保留。以下是供操作者选择的操作，不是在诊断期间执行的命令：

- 当后台辅助进程协调迟到的就绪证据时，保持存活或未知 Attempt 的保留状态；在已验证终端中检查信任、登录或授权提示，并由用户明确处理。
- 使用 `pc workflow orchestrator recover <run> --config <config>`（可选 `--detailed`）明确请求现有协调。在原生身份、终端、初始化和权限门槛均通过后，这可能激活同一 Attempt；它不是只读检查。
- 合适时通过原始 `start` 请求重新连接。重复 start 会重连未结束的 Run，修复停止的辅助进程而不重新启动执行；保留原提供方和不可变要求。它可能推进启动，应由操作者主动选择。
- 仅在前任 Orchestrator 已被独立验证终止后，使用 `pc workflow orchestrator recover <run> --replace --config <config>`。阶段重试同样要求验证终止，并创建包含当前协调指令的新 Attempt。不得复用前任启动权限或重放已接受工作。
- 仅在全部记录执行均已验证终止、且完成必要保存/清理后，通过现有 `releaseRunCheckout` 契约释放工作目录。这是驱动层操作，不是新增恢复 CLI 命令。不得删除归属标记，也不得根据超时或完成输出推断可以释放。

当每个门槛都有已验证证据或明确保留的阻塞、当前占用和权限已记录、且操作者能选择现有操作时，诊断完成。成功重连要求选定的当前 Attempt、有效初始化、已提交激活和已确认继续消息；业务验收及资源释放仍是独立事项。

## 证据边界

短提示可减少转录截断风险，但不能保证完全避免。模拟协议测试无法证明原生 agy 完整读取启动文档，也不能确定原生转录限制。文档验证不得运行真实提供方冒烟测试、恢复报告涉及的 Run 或执行下游科学分析。具体事件的报告证据单独保留于[事件记录](../research/agy-startup-112.md)。
