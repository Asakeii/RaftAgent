# Architecture illustration

Generated with the built-in image generation tool for the README. This is a conceptual architecture illustration, not a runtime trace or UI screenshot.

## Prompt

Use case: infographic-diagram. Generate a polished illustrated software architecture hero for the GitHub README of "RaftAgent", a local multi-agent collaboration workbench with extensible Skills. Use image-2. Landscape approximately 2:1, high resolution, excellent readable typography at README width. This is an architecture diagram, but MUST feel warm, playful, editorial and alive, not a stiff enterprise block diagram.

Visual style: creamy off-white background, charcoal crisp type, tangerine orange primary accent, teal and a little pink; subtle paper grain, delicate ink outlines, soft depth, rounded modular objects, small expressive abstract robot mascots. Balanced generous whitespace. A charming tabletop/workbench cutaway, gentle isometric details mixed with clear flat labels. No photorealism, no dark cyberpunk, no neon, no dense UML rectangles, no fake screenshots, no tiny decorative text.

Architecture content and exact labels:
A small person with a task note on the left labeled "用户 / User", connected to a central lively shared conversation area labeled "共享群聊 / Shared Room". Three distinct little agents in orange, pink, teal cluster around that conversation, clearly labeled "Agent A", "Agent B", "Agent C". Each agent has its OWN tiny incoming-message tray labelled "Inbox"; visually make three separate trays, not one central screening agent. Thin curved bidirectional connectors show conversation exchange and @ message slips.

On the right, show a tidy modular bookshelf/tool rack labeled "共享 Skill 库". Three plug-in modules with readable short labels "搜索", "协作", "自定义脚本". A small adjacent terminal labeled "CLI" connects to a compact workshop area labeled "SDK Bash 沙箱"; illustrate a file and small gear inside the sandbox. Arrows from agents to skill rack convey loading instructions, arrows from agents through CLI to sandbox convey execution. One elegant returning curved orange loop from the sandbox/tools back to the skill rack labeled "编写 → 发布 → 热加载", conveying evolution by publishing reusable capabilities, not model-weight training.

The collaboration area and execution workshop sit on a subtle broad platform labeled "Claude Agent SDK · 本地运行". Include a small database cylinder within this platform labeled "SQLite". Above/outside the platform a small airy cloud labelled "模型 API" connects to the platform, clearly indicating inference is external, not a local model.

Across the lower part, a restrained dotted orange observation trail with 5 small nodes and one magnifying glass, labeled "Trace · 执行监测", connected lightly to the agents and CLI; short node labels exactly "输入", "Skill 加载", "工具执行", "回执", "结果". Monitoring is an observing thread, NOT the execution controller.

Top left small wordmark "raft." with orange period. No large title repeating RaftAgent, no extra paragraphs, no invented metrics or claims, no logos for external vendors. All arrows must be clean and sparse with minimal crossings. Ensure every Chinese label is legible and spelled correctly. Emphasize the three agent characters, shared conversation, modular skill rack and flowing trace. A technically honest conceptual architecture illustration, premium playful developer-tool aesthetic.
