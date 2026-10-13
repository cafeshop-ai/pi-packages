import { useTranslation } from 'react-i18next';
const en = {
  emptyConversation: 'Start a conversation', emptyConversationHelp: 'Send a message to the selected Pi. Replies and tool results will appear here.',
  conversation: 'Conversation', assistant: 'Assistant', user: 'You', system: 'System', tool: 'Tool result',
  reasoning: 'Reasoning', incomplete: 'This page shows a shortened history or content. Refer to local Pi for the full record.', parentMissing: 'The calling message is outside this view; the tool execution is retained.',
  nestedTools: 'Internal tools', ambiguous: 'Ambiguous tool association', args: 'Arguments',
  invalidArgs: 'Arguments are incomplete or unvalidated', output: 'Output', empty: 'Empty output', noOutput: 'No output yet',
  pending: 'Awaiting execution evidence', running: 'Running', complete: 'Completed', error: 'Failed', conflict: 'Conflicting evidence',
  imageOmitted: 'Image not loaded', waiting: 'Waiting for input in local Pi', history: 'Read-only history',
};
const zh: typeof en = {
  emptyConversation: '开始这段对话', emptyConversationHelp: '发送消息给当前 Pi；回复和工具执行结果会显示在这里。',
  conversation: '对话', assistant: '助手', user: '你', system: '系统', tool: '工具结果', reasoning: '思考',
  incomplete: '网页展示的历史或内容已精简，完整记录请以本地 Pi 为准。', parentMissing: '当前展示范围内没有对应的调用消息，工具执行记录仍保留。', nestedTools: '内部调用', ambiguous: '工具关联存在歧义',
  args: '参数', invalidArgs: '参数不完整或尚未验证', output: '输出', empty: '输出为空', noOutput: '暂无输出',
  pending: '等待执行信息', running: '执行中', complete: '已完成', error: '失败', conflict: '状态信息冲突',
  imageOmitted: '未加载图片', waiting: '等待在本地 Pi 中操作', history: '只读历史',
};
export function useChatLabels() {
  const { i18n } = useTranslation();
  return i18n.language?.startsWith('zh') ? zh : en;
}
