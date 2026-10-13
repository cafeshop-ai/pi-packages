import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/Controls';
import { toolPresentation, type DiffRow } from './toolPresentation';
import type { ToolView } from '../runtime/convertMessages';
import { useDisclosure } from './CollapseState';
import { useChatLabels } from './labels';
import styles from './Conversation.module.scss';
import { Icon } from '../../../components/ui/Icon';
export function isToolView(value: unknown): value is ToolView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === 'string' && typeof v.callId === 'string' && typeof v.name === 'string' && typeof v.argsText === 'string' && typeof v.output === 'string' && typeof v.argsValid === 'boolean' && typeof v.hasOutput === 'boolean' && typeof v.conflict === 'boolean' && ['pending', 'running', 'complete', 'error'].includes(String(v.status)) && ['attached', 'missing-parent', 'ambiguous'].includes(String(v.association)) && (v.nestedTools === undefined || Array.isArray(v.nestedTools) && v.nestedTools.length <= 100 && v.nestedTools.every(child => child?.nestedTools === undefined && isToolView(child)));
}
function DiffPreview({ rows, source }: { rows: DiffRow[]; source: 'result' | 'requested-edit' }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [expanded, setExpanded] = useState(false), [wrap, setWrap] = useState(true);
  const visible = expanded ? rows : rows.slice(0, 60);
  return <section className={styles.diff} aria-label={zh ? '代码变更预览' : 'Code change preview'}>
    <header><span>{source === 'result' ? (zh ? '工具返回的变更' : 'Diff returned by tool') : (zh ? '请求的修改 · 行号相对片段' : 'Requested edit · snippet line numbers')}</span><Button variant="quiet" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>{zh ? '换行' : 'Wrap'}</Button></header>
    <div className={styles.diffRows} data-wrap={wrap} tabIndex={0} aria-label={zh ? '增删代码' : 'Added and removed code'}>{visible.map((row, index) => <div className={styles.diffRow} data-kind={row.kind} key={index}><span className={styles.diffNumber} aria-hidden="true">{row.kind === 'remove' ? row.oldLine : row.newLine}</span><span className={styles.diffSign}>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : row.kind === 'separator' ? '⋯' : ' '}</span><code>{row.text || ' '}</code></div>)}</div>
    {!expanded && rows.length > visible.length && <Button variant="quiet" className={styles.expandDiff} onClick={() => setExpanded(true)}>{zh ? `展开其余 ${rows.length - visible.length} 行` : `Show ${rows.length - visible.length} more lines`}</Button>}
  </section>;
}
export function ToolPart({ view }: { view: ToolView }) {
  const labels = useChatLabels(), { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const presentation = useMemo(() => toolPresentation(view), [view.name, view.argsText, view.argsValid, view.output, view.hasOutput, view.status]);
  const nestedFailures = view.nestedTools?.filter(tool => tool.status === 'error').length ?? 0;
  const disclosure = useDisclosure(view.key, view.status === 'error' || nestedFailures > 0);
  return <details className={clsx(styles.tool, view.status === 'error' && styles.failure)} data-tool-id={view.callId} data-tool-status={view.status} open={disclosure.open}>
    <summary onClick={event => { event.preventDefault(); disclosure.setOpen(!disclosure.open); }}><span className={styles.toolDot} aria-hidden="true">●</span><strong>{presentation.title}</strong>{presentation.target && <code className={styles.toolTarget} title={presentation.target}>{presentation.target}</code>}<span className={styles.toolStatus}>{labels[view.status]}</span>{presentation.diff && <span className={styles.diffStat}><b>+{presentation.added}</b><i>−{presentation.removed}</i></span>}{view.conflict && <span className={styles.warning}>{labels.conflict}</span>}{!!view.nestedTools?.length && <span>{labels.nestedTools} · {view.nestedTools.length}{nestedFailures > 0 && <span className={styles.warning}> · {labels.error} {nestedFailures}</span>}</span>}</summary>
    {view.association !== 'attached' && <p className={styles.warning}>{view.association === 'ambiguous' ? labels.ambiguous : labels.parentMissing}</p>}
    <div className={styles.toolBody}>
      {presentation.diff && presentation.source && <DiffPreview rows={presentation.diff} source={presentation.source} />}
      {view.hasOutput && !presentation.diff ? view.output === '' ? <p>{labels.empty}</p> : <><pre className={styles.outputPreview}>{presentation.outputPreview}</pre>{presentation.outputTruncated && <details className={styles.rawData}><summary><Icon name="chevron" />{zh ? `查看完整输出 · ${presentation.outputLines} 行` : `Full output · ${presentation.outputLines} lines`}</summary><pre>{view.output}</pre></details>}</> : !view.hasOutput && <p>{view.status === 'running' ? (zh ? '工具正在执行，等待输出…' : 'Tool is running, waiting for output…') : labels.noOutput}</p>}
      {presentation.diff && view.hasOutput && <details className={styles.rawData}><summary><Icon name="chevron" />{labels.output}</summary><pre>{view.output || labels.empty}</pre></details>}
      <details className={styles.rawData}><summary><Icon name="chevron" />{labels.args}</summary>{!view.argsValid && <p className={styles.warning}>{labels.invalidArgs}</p>}<pre>{view.argsText}</pre></details>
      {view.nestedTools && <section aria-label={labels.nestedTools}>{view.nestedTools.map(tool => <ToolPart key={tool.key} view={tool} />)}</section>}
    </div>
  </details>;
}
