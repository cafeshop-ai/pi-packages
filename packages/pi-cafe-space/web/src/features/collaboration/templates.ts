// Starter checklists for an empty task board. The version is part of every task id, so a
// repeated click returns the same tasks, and editing a template later never conflicts with
// tasks created from the old wording.
export type Template = { key: string; label: string; hint: string; tasks: string[] };

export const templates: Template[] = [
  { key: 'review-v1', label: '代码评审', hint: '范围 → 测试 → 问题 → 复核', tasks: [
    '说明评审范围：分支、提交与改动目的',
    '运行测试并贴出结果',
    '列出问题：正确性、安全、性能',
    '逐条修复或回应',
    '复核修复并给出结论',
  ] },
  { key: 'debug-v1', label: '故障排查', hint: '现象 → 证据 → 假设 → 恢复', tasks: [
    '描述现象：影响范围、开始时间、复现步骤',
    '收集证据：日志、监控、最近变更',
    '提出假设并逐一验证',
    '修复或止损，写明回滚方式',
    '确认恢复，记录根因与后续',
  ] },
  { key: 'handoff-v1', label: '工作交接', hint: '现状 → 入口 → 风险 → 验证', tasks: [
    '列出现状：已完成、进行中、未开始',
    '给出入口：代码位置、部署与运行方式（不贴凭据）',
    '列出已知风险与待决事项',
    '接手方复述并提问',
    '接手方独立跑通一次关键流程',
  ] },
];

export const templateTaskId = (template: Template, index: number) => `template-${template.key}-${index + 1}`;
