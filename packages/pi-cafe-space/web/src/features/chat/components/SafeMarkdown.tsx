import { MarkdownTextPrimitive, type MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown';
import { useChatLabels } from './labels';
import styles from './Conversation.module.scss';
export function safeLink(value: string): string {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try { const url = new URL(value); return url.username || url.password ? '' : url.href; } catch { return ''; }
}
const components: NonNullable<MarkdownTextPrimitiveProps['components']> = {
  a: ({ href, children }) => safeLink(href ?? '') ? <a href={safeLink(href!)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>,
  img: function OmittedImage({ alt }) { const labels = useChatLabels(); return <span className={styles.warning}>[{labels.imageOmitted}{alt ? `: ${alt}` : ''}]</span>; },
  pre: ({ children }) => <pre>{children}</pre>,
  code: ({ children }) => <code>{children}</code>,
  CodeHeader: () => null,
  SyntaxHighlighter: ({ code }) => <pre><code>{code}</code></pre>,
};
// No raw-HTML plugins, executable diagrams, syntax-highlighter style injection,
// image fetches, or inline styles. Only user-activated HTTP(S) navigation.
export function SafeMarkdown() {
  return <MarkdownTextPrimitive className={styles.markdown} skipHtml smooth={false} urlTransform={safeLink} components={components} allowedElements={['p', 'em', 'strong', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img']} />;
}
