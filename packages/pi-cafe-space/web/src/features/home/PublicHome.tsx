import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { Button, Input, Label } from '../../components/ui/Controls';
import { Icon } from '../../components/ui/Icon';
import { RoomLanding } from '../remote/RoomEntry';
import { classifyEntryLink } from './entryLink';
import appStyles from '../../app/App.module.scss';
import setupStyles from '../auth/SetupForm.module.scss';
import styles from './PublicHome.module.scss';

export type PublicView = 'home' | 'devices' | 'share';

/** Public pages: "/" (home), "/devices" (open a shared device) and "/devices/share" (set one up). */
export function publicView(pathname: string): PublicView {
  if (pathname === '/devices') return 'devices';
  if (pathname === '/devices/share') return 'share';
  return 'home';
}

function useZh() {
  const { i18n } = useTranslation();
  return { zh: i18n.language.startsWith('zh'), i18n };
}

export function PublicHeader({ view }: { view: PublicView }) {
  const { zh, i18n } = useZh();
  return <header className={`${appStyles.header} ${styles.header}`}>
    <Link to="/" className={styles.brand} aria-current={view === 'home' ? 'page' : undefined}>Café Space</Link>
    <nav className={styles.nav} aria-label={zh ? '站点导航' : 'Site'}>
      <Link to="/devices" aria-current={view === 'devices' || view === 'share' ? 'page' : undefined}>{zh ? '远程电脑' : 'Remote device'}</Link>
      <Link to="/collab">{zh ? '协作房间' : 'Collaboration'}</Link>
    </nav>
    <nav className={`${appStyles.language} ${setupStyles.language}`} aria-label={zh ? '语言' : 'Language'}>
      <Button variant="quiet" aria-pressed={zh} onClick={() => void i18n.changeLanguage('zh-CN')}>中文</Button>
      <Button variant="quiet" aria-pressed={!zh} onClick={() => void i18n.changeLanguage('en')}>English</Button>
    </nav>
  </header>;
}

export function PublicHome() {
  const { zh } = useZh(); const navigate = useNavigate();
  const [link, setLink] = useState(''); const [error, setError] = useState(false);
  const hintId = useId(); const errorId = useId();
  const open = (event: FormEvent) => {
    event.preventDefault();
    // Local classification only: nothing is sent until the target page runs its own flow.
    const target = classifyEntryLink(link, window.location.origin);
    if (target.kind === 'invalid') { setError(true); return; }
    navigate(target.path);
  };
  return <div className={styles.page}>
    <section className={styles.hero} aria-labelledby="home-title">
      <p className={setupStyles.eyebrow}>CAFÉ SPACE</p>
      <h1 id="home-title" className={styles.title}>{zh ? '你的电脑，你的团队，同一个空间。' : 'Your computer and your team, in one space.'}</h1>
      <p className={styles.lead}>{zh ? '在任何地方使用你自己的电脑，并与同事和 AI 在共享房间里协作。' : 'Use your own computer from anywhere, and work with people and AI in shared rooms.'}</p>
      <form className={styles.linkBox} onSubmit={open} noValidate>
        <Label htmlFor="entry-link">{zh ? '已有链接？粘贴到这里' : 'Have a link? Paste it here'}</Label>
        <div className={styles.linkRow}>
          <Input id="entry-link" className={styles.linkInput} autoCapitalize="none" spellCheck={false} autoComplete="off" value={link} maxLength={2048}
            aria-invalid={error || undefined} aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            onChange={event => { setLink(event.target.value); setError(false); }} placeholder="https://…/#/…" />
          <Button type="submit" variant="primary" className={styles.open}>{zh ? '打开' : 'Open'}<Icon name="chevron" /></Button>
        </div>
        <p id={hintId} className={styles.hint}>{zh ? '支持远程电脑的房间链接或房间 key，以及协作房间的邀请链接。' : 'Accepts a remote-device room link or room key, or a collaboration invite link.'}</p>
        {error && <p id={errorId} className={styles.error} role="alert">{zh
          ? '无法识别这个链接。请粘贴本站的远程电脑房间链接（…/#/room/…）、房间 key，或协作邀请链接（…/#/collab/…?invite=…）。'
          : 'This link was not recognized. Paste a remote-device room link from this site (…/#/room/…), a room key, or a collaboration invite (…/#/collab/…?invite=…).'}</p>}
      </form>
    </section>
    <div className={styles.cards}>
      <section className={styles.card} aria-labelledby="home-devices">
        <span className={styles.cardIcon}><Icon name="hosts" /></span>
        <h2 id="home-devices">{zh ? '远程电脑' : 'Remote device'}</h2>
        <p className={styles.cardLead}>{zh ? '用手机或另一台电脑的浏览器，打开你办公电脑上的 Pi。' : 'Open the Pi on your own office computer from a phone or another browser.'}</p>
        <ul className={styles.facts}>
          <li><Icon name="lock" />{zh ? '房间不公开列出，进入需要房间密码。' : 'Rooms are never listed and need the room password.'}</li>
          <li><Icon name="check" />{zh ? '访客只需浏览器、房间链接和密码。' : 'Visitors need only a browser, the link and the password.'}</li>
          <li><Icon name="folder" />{zh ? '被分享的电脑需安装 Café Space，并保持网关运行。' : 'The shared computer runs Café Space and keeps its gateway online.'}</li>
        </ul>
        <div className={styles.actions}>
          <Link className={styles.primary} to="/devices">{zh ? '打开共享电脑' : 'Open a shared device'}</Link>
          <Link className={styles.secondary} to="/devices/share">{zh ? '分享这台电脑' : 'Share this computer'}<Icon name="chevron" /></Link>
        </div>
      </section>
      <section className={styles.card} aria-labelledby="home-collab">
        <span className={styles.cardIcon}><Icon name="message" /></span>
        <h2 id="home-collab">{zh ? '协作房间' : 'Collaboration room'}</h2>
        <p className={styles.cardLead}>{zh ? '同事和各自的 AI 在同一个房间里讨论、分工，并跟踪共同目标。' : 'Colleagues and their AIs discuss, split tasks and track a shared Goal.'}</p>
        <ul className={styles.facts}>
          <li><Icon name="lock" />{zh ? '只共享房间里的内容，不会打开任何人的电脑。' : 'Only room content is shared; no one’s computer is opened.'}</li>
          <li><Icon name="check" />{zh ? '用浏览器参与无需安装；AI 用自己的工具通过 HTTPS 加入。' : 'Joining in a browser needs no install; AIs join over HTTPS with their own tools.'}</li>
          <li><Icon name="share" />{zh ? '凭邀请链接加入，房间会按期到期。' : 'Join with an invite link; rooms expire on schedule.'}</li>
        </ul>
        <div className={styles.actions}>
          <Link className={styles.primary} to="/collab">{zh ? '新建协作房间' : 'Create a room'}</Link>
          <Link className={styles.secondary} to="/collab">{zh ? '用邀请链接加入' : 'Join with an invite'}<Icon name="chevron" /></Link>
        </div>
      </section>
    </div>
    <footer className={styles.footer}>
      <a href="/api/collaboration/guide" target="_blank" rel="noreferrer">{zh ? 'AI 接入协议（HTTP）' : 'AI connection protocol (HTTP)'}</a>
    </footer>
  </div>;
}

export function DevicesHub({ owner }: { owner: AppOwner }) {
  const { zh } = useZh();
  return <div className={styles.page}>
    <section className={styles.hero} aria-labelledby="devices-title">
      <h1 id="devices-title" className={styles.title}>{zh ? '远程电脑' : 'Remote device'}</h1>
      <p className={styles.lead}>{zh ? '打开别人分享给你的电脑，或者把你自己的电脑分享出来。' : 'Open a computer someone shared with you, or share your own.'}</p>
    </section>
    <div className={styles.split}>
      <RoomLanding owner={owner} />
      <section className={setupStyles.card} aria-labelledby="devices-share">
        <p className={setupStyles.eyebrow}>{zh ? '分享' : 'SHARE'}</p>
        <h2 className={setupStyles.title} id="devices-share">{zh ? '分享这台电脑' : 'Share this computer'}</h2>
        <p className={setupStyles.intro}>{zh ? '在要分享的电脑上安装 Café Space，即可生成房间链接和二维码。' : 'Install Café Space on the computer you want to share to get its room link and QR code.'}</p>
        <div className={setupStyles.footer}><Link className={styles.primary} to="/devices/share">{zh ? '查看设置步骤' : 'See the setup steps'}</Link></div>
      </section>
    </div>
  </div>;
}

export function ShareGuide() {
  const { zh } = useZh();
  const origin = window.location.origin;
  const steps = zh ? [
    '向发布者索取预构建安装包（.tgz），并通过独立可信的渠道取得它的 SHA-256，校验后再解压。',
    `在要分享的电脑上准备 Node 22.19+ 和 Pi CLI，按包内 INSTALL.md 运行安装器，并连接 ${origin}。也可以把安装包和包内的 AI_INSTALL.md 交给你的 AI 助手。`,
    '启动房间网关，打开本机网页，亲自设置 6–20 位的本机令牌。',
    '点击「分享房间」复制链接或展示二维码。密码不在链接里，请另行告知访客。',
  ] : [
    'Get the prebuilt package (.tgz) from the publisher, plus its SHA-256 through a separate trusted channel. Verify it, then extract it.',
    `On the computer you want to share, have Node 22.19+ and the Pi CLI ready, then follow INSTALL.md in the package to run its installer against ${origin}. You can also give the package and its AI_INSTALL.md to your AI assistant.`,
    'Start the room gateway, open the local page, and set your own 6–20 character local token.',
    'Click Share room to copy the link or show a QR code. The password is not in the link; tell your visitors separately.',
  ];
  return <div className={styles.page}>
    <section className={styles.guide} aria-labelledby="share-title">
      <p className={setupStyles.eyebrow}>{zh ? '远程电脑' : 'REMOTE DEVICE'}</p>
      <h1 id="share-title" className={styles.title}>{zh ? '分享这台电脑' : 'Share this computer'}</h1>
      <ol className={styles.steps}>{steps.map(step => <li key={step}>{step}</li>)}</ol>
      <div className={setupStyles.note}><Icon name="lock" /><p>{zh
        ? '电脑需要保持联网并让网关持续运行。不要运行未经查看的远程脚本（例如 curl | sh），也不要在聊天里发送令牌或密码。'
        : 'The computer must stay online with the gateway running. Do not run unreviewed remote scripts (such as curl | sh), and never send tokens or passwords in chat.'}</p></div>
      <Link className={styles.secondary} to="/devices">{zh ? '返回远程电脑' : 'Back to Remote device'}</Link>
    </section>
  </div>;
}
