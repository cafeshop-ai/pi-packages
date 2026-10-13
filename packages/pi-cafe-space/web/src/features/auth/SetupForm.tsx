import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Label } from '../../components/ui/Controls';
import { Icon } from '../../components/ui/Icon';
import styles from './SetupForm.module.scss';

async function setupRequest(method: 'GET' | 'POST', nonce: string, body?: { token: string; confirmToken: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const cancel = new AbortController(); const abort = () => cancel.abort();
  if (signal?.aborted) throw Error('REQUEST_CANCELLED');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try {
  const response = await fetch('/api/setup', { method, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: cancel.signal,
    headers: { Accept: 'application/json', 'X-Cafe-Setup': nonce, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  if (raw.length > 4096) throw Error('SETUP_UNAVAILABLE');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('SETUP_UNAVAILABLE');
  const result = value as Record<string, unknown>;
  if (!response.ok) throw Error(typeof result.error === 'string' && /^[A-Z_]+$/.test(result.error) ? result.error : 'SETUP_UNAVAILABLE');
  return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export function SetupForm({ onComplete, onRefresh }: { onComplete: (token: string) => void; onRefresh: () => void }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh'); const id = useId();
  const [nonce, setNonce] = useState(''); const [token, setToken] = useState(''); const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submitting = useRef(false); const alive = useRef(false); const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const cancel = new AbortController(); controller.current = cancel; alive.current = true;
    void setupRequest('GET', '1', undefined, cancel.signal).then(result => {
      if (cancel.signal.aborted) return;
      if (result.required === false) { setError('ALREADY_INITIALIZED'); return; }
      if (result.required !== true || typeof result.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.nonce)) throw Error('SETUP_UNAVAILABLE');
      setNonce(result.nonce);
    }).catch(() => { if (!cancel.signal.aborted) setError('SETUP_UNAVAILABLE'); });
    return () => { alive.current = false; cancel.abort(); };
  }, []);
  const messages: Record<string, string> = zh ? {
    TOKEN_MISMATCH: '两次输入的令牌不一致。', INVALID_TOKEN: '请输入 6–20 个字符，不含首尾空白或控制字符。',
    ALREADY_INITIALIZED: '已在另一页面完成初始化，请进入登录页。', CREDENTIALS_NOT_SAVED: '凭据未保存。请检查本机凭据目录的权限，或刷新查看是否已由另一进程完成。',
    SETUP_UNAVAILABLE: '无法读取初始化状态，请确认本机服务在线后刷新。', RESULT_UNKNOWN: '未收到保存确认。请刷新检查状态，不要假定保存失败并反复提交。',
  } : {
    TOKEN_MISMATCH: 'The tokens do not match.', INVALID_TOKEN: 'Enter 6–20 characters, without surrounding whitespace or control characters.',
    ALREADY_INITIALIZED: 'Another page has completed setup. Continue to sign in.', CREDENTIALS_NOT_SAVED: 'Credentials were not saved. Check the private directory permissions or refresh to check another initializer.',
    SETUP_UNAVAILABLE: 'Cannot read setup state. Check that the local service is online and refresh.', RESULT_UNKNOWN: 'Save acknowledgement was not received. Refresh to check the state before submitting again.',
  };
  const submit = async () => {
    if (submitting.current || !nonce) return;
    if (token !== confirm) { setError('TOKEN_MISMATCH'); return; }
    if (token.length < 6 || token.length > 20 || token.trim() !== token || /[\u0000-\u001f\u007f-\u009f]/.test(token)) { setError('INVALID_TOKEN'); return; }
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await setupRequest('POST', nonce, { token, confirmToken: confirm }, controller.current?.signal);
      if (result.initialized !== true) throw Error('RESULT_UNKNOWN');
      if (alive.current) { const selected = token; setToken(''); setConfirm(''); setNonce(''); onComplete(selected); }
    } catch (reason) {
      if (alive.current) { const code = reason instanceof Error ? reason.message : ''; setError(messages[code] ? code : 'RESULT_UNKNOWN'); }
    } finally { submitting.current = false; if (alive.current) setBusy(false); }
  };
  return <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className={styles.intro}>{zh ? '设置一个令牌，用于之后登录工作空间。' : 'Choose a token to sign in to your workspace.'}</p>
    <div className={styles.fields}>
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <Label htmlFor={`${id}-token`}>{zh ? '访问令牌' : 'Access token'}</Label>
          <Button type="button" variant="quiet" className={styles.generate} disabled={busy} onClick={() => {
            const bytes = crypto.getRandomValues(new Uint8Array(10)); const generated = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            setToken(generated); setConfirm(generated); setShow(true); setError('');
          }}><Icon name="refresh" />{zh ? '生成随机令牌' : 'Generate random token'}</Button>
        </div>
        <div className={styles.inputWrap}>
          <Input className={styles.input} id={`${id}-token`} type={show ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={token} required minLength={6} maxLength={20} disabled={busy} aria-describedby={`${id}-note`} aria-invalid={error === 'INVALID_TOKEN'} placeholder={zh ? '6–20 位，自定义即可' : '6–20 characters'} onChange={event => setToken(event.target.value)} />
          <Button type="button" variant="quiet" className={styles.visibility} disabled={busy} aria-label={zh ? (show ? '隐藏令牌' : '显示令牌') : (show ? 'Hide token' : 'Show token')} aria-pressed={show} onClick={() => setShow(value => !value)}>{zh ? (show ? '隐藏' : '显示') : (show ? 'Hide' : 'Show')}</Button>
        </div>
      </div>
      <div className={styles.field}>
        <Label htmlFor={`${id}-confirm`}>{zh ? '确认令牌' : 'Confirm token'}</Label>
        <Input className={styles.input} id={`${id}-confirm`} type={show ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={confirm} required minLength={6} maxLength={20} disabled={busy} aria-invalid={error === 'TOKEN_MISMATCH'} placeholder={zh ? '再次输入令牌' : 'Enter it again'} onChange={event => setConfirm(event.target.value)} />
      </div>
    </div>
    <div id={`${id}-note`} className={styles.note}><Icon name="lock" /><div>
      <p>{zh ? '请保存好令牌，之后登录时使用。' : 'Keep your token safe for your next sign-in.'}</p>
      <p>{zh ? '不是模型 API Key。Pi 连接密钥由本机独立管理。' : 'Not a model API key. Pi manages its connection key locally.'}</p>
    </div></div>
    {error && <div className={styles.error}><p role="alert">{messages[error] ?? messages.SETUP_UNAVAILABLE}</p><Button type="button" variant="quiet" disabled={busy} onClick={onRefresh}>{zh ? '刷新初始化状态' : 'Refresh setup state'}</Button></div>}
    <div className={styles.footer}><Button type="submit" className={styles.submit} variant="primary" disabled={!nonce || busy || error === 'ALREADY_INITIALIZED' || error === 'RESULT_UNKNOWN'}>{busy ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存并进入 Café Space' : 'Save and open Café Space')}<Icon name="chevron" /></Button></div>
  </form>;
}
