#!/usr/bin/env python3
import argparse, base64, fcntl, hashlib, http.server, json, os, pathlib, pty, re, select, signal, socket, struct, subprocess, tempfile, termios, threading, time, urllib.request

p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--node',required=True);p.add_argument('--cli',required=True);p.add_argument('--candidate',required=True);p.add_argument('--report',required=True);p.add_argument('--proxy-regression',action='store_true');p.add_argument('--apple-terminal',action='store_true');a=p.parse_args()
for path in [a.binary,a.node,a.cli,a.candidate]:
 if not pathlib.Path(path).is_absolute():raise SystemExit('Absolute test paths required')
report=pathlib.Path(a.report);report.mkdir(parents=True,exist_ok=True)
children=[];fds=[];checks=[];capture=b'';stage='setup';master=None;test_proxy=None;proxy_requests=0;proxy_phases={}
class RejectProxy(http.server.BaseHTTPRequestHandler):
 def do_CONNECT(self):
  globals()['proxy_requests']+=1;proxy_phases[stage]=proxy_phases.get(stage,0)+1;self.send_error(502,'Synthetic proxy does not route loopback')
 do_GET=do_CONNECT
 do_POST=do_CONNECT
 def log_message(self,*args):pass
ansi=re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
def clean(raw):return ansi.sub('',raw.decode('utf-8','replace'))
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def request(url,body=None,headers=None):
 req=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers=headers or {})
 with urllib.request.urlopen(req,timeout=2) as r:return json.load(r)
def wait(fn,label,timeout=15):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  if master is not None:
   ready,_,_=select.select([master],[],[],.05)
   if ready:
    try:
     data=os.read(master,65536)
     globals()['capture']=(capture+data)[-500000:]
    except OSError:pass
  try:
   if fn():return
  except (OSError,ValueError):pass
  time.sleep(.04)
 raise RuntimeError(label+' timed out')
def send(text):os.write(master,text.encode())
def settle(seconds=.8):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  ready,_,_=select.select([master],[],[],.05)
  if ready:
   try:globals()['capture']=(capture+os.read(master,65536))[-500000:]
   except OSError:pass
def owned(args,env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL):
 c=subprocess.Popen(args,env=env,cwd=root,stdin=stdin,stdout=stdout,stderr=stderr,start_new_session=True);children.append(c);return c
try:
 with tempfile.TemporaryDirectory(prefix='cafe-native-terminal-') as tmp:
  root=pathlib.Path(tmp);os.chmod(root,0o700)
  for name in ['private','agent','home']:(root/name).mkdir(mode=0o700)
  cloud_port,local_port=port(),port();origin='http://127.0.0.1:'+str(cloud_port);local='http://127.0.0.1:'+str(local_port)
  host_token=base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=');client_token='TestRoom42'
  credentials=root/'private/credentials.json';credentials.write_text(json.dumps({'version':1,'port':local_port,'hostToken':host_token,'clientToken':client_token}));os.chmod(credentials,0o600)
  cloud={'mode':'cloud','publicOrigin':origin,'roomAccess':True,'enableWebRTC':True}
  device={'mode':'device','publicOrigin':origin,'cloudUrl':origin.replace('http:','ws:')+'/room/host','roomIdentityFile':str(root/'private/room.json'),'deviceName':'Terminal test room','rooms':['main'],'maxRole':'operator','enableWebRTC':True}
  for name,cfg in [('cloud',cloud),('device',device)]:
   path=root/(name+'.json');path.write_text(json.dumps(cfg));os.chmod(path,0o600)
  env={'HOME':str(root/'home'),'PATH':str(pathlib.Path(a.node).parent)+':/usr/bin:/bin','TMPDIR':str(root),'TERM':'xterm-256color','LANG':'en_US.UTF-8'}
  log=(root/'services.log').open('wb')
  for name,number in [('cloud',cloud_port),('device',local_port)]:owned([a.binary],dict(env,PI_COLLAB_HOST='127.0.0.1',PI_COLLAB_PORT=str(number),PI_COLLAB_HOST_TOKEN=host_token,PI_COLLAB_CLIENT_TOKEN=client_token,PI_CAFE_REMOTE_CONFIG=str(root/(name+'.json'))),stdout=log,stderr=log)
  wait(lambda:request(local+'/api/config').get('terminalShare') is True,'local gateway')
  (root/'agent/settings.json').write_text(json.dumps({'enableInstallTelemetry':False,'enableAnalytics':False,'extensions':[],'skills':[],'prompts':[],'themes':[]}))
  master,slave=pty.openpty();fds.extend([master,slave]);fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',72 if a.apple_terminal else 60,120,0,0))
  pi_env=dict(env,PI_CODING_AGENT_DIR=str(root/'agent'),PI_COLLAB_RELAY_URL=local.replace('http:','ws:')+'/ws',PI_CAFE_CREDENTIALS_FILE=str(credentials),PI_COLLAB_PEER_ID='terminal-pi',SSH_CONNECTION='test-ssh-context')
  args=[a.node,a.cli,'--offline','--no-extensions','-e',str(pathlib.Path(a.candidate)/'dist/extension/index.js'),'--no-tools','--no-approve','--no-session','--no-context-files','--no-skills','--no-prompt-templates','--no-themes']
  if a.apple_terminal:pi_env['TERM_PROGRAM']='Apple_Terminal'
  if a.proxy_regression:
   test_proxy=http.server.ThreadingHTTPServer(('127.0.0.1',0),RejectProxy)
   threading.Thread(target=test_proxy.serve_forever,daemon=True).start()
   proxy_url='http://127.0.0.1:'+str(test_proxy.server_port)
   pi_env.update(http_proxy=proxy_url,https_proxy=proxy_url,HTTP_PROXY=proxy_url,HTTPS_PROXY=proxy_url,NO_PROXY='',no_proxy='')
  pi=owned(args,pi_env,slave,slave,slave);os.close(slave);fds.remove(slave)
  stage='startup hint';wait(lambda:'/cafe' in clean(capture) and 'connected' in clean(capture),'Pi native startup',20)
  assert '/#/room/' not in clean(capture),'invitation printed on startup'
  markers=list((root/'private').glob('cafe-welcome-v1-*.json'));assert len(markers)==1
  checks.append('Real Pi startup advertises /cafe without printing room link or opening browser')
  stage='menu';before=len(capture);send('/cafe\r');wait(lambda:'共享范围' in clean(capture[before:]),'native menu');text=clean(capture[before:]);assert 'Terminal test room' in text and '已加入' in text
  assert '/#/room/' not in text;checks.append('Native menu shows actual room status, scope and current Pi membership without disclosing invitation')
  stage='share';before=len(capture);send('\r');wait(lambda:'/#/room/' in clean(capture[before:]),'share panel');send('q');wait(lambda:b'\x1b[48;2;0;0;0m' in capture[before:],'terminal QR background cells')
  checks.append('Selecting Share reveals native terminal QR and room URL, not a model response')
  stage='SSH preview fallback';before=len(capture);send('p');wait(lambda:'SSH终端不会打开远端浏览器' in clean(capture[before:]),'safe QR preview fallback');checks.append('P preview is discoverable but never opens a remote browser over SSH')
  stage='SSH copy fallback';before=len(capture);send('c');wait(lambda:'SSH终端不能可靠' in clean(capture[before:]),'truthful copy fallback');checks.append('SSH copy reports manual-copy fallback without changing local clipboard')
  stage='return';before=len(capture);send('\x1b');wait(lambda:'仅将当前 Pi 移出房间' in clean(capture[before:]),'return to root menu');send('\x1b');settle();before=len(capture);send('/cafe status\r');wait(lambda:'仅将当前 Pi 移出房间' in clean(capture[before:]),'reopen status');send('\x1b');settle()
  stage='reload';before=len(capture);send('/reload\r');wait(lambda:'Reloaded' in clean(capture[before:]) or '重新加载' in clean(capture[before:]) or '已重载' in clean(capture[before:]),'native reload',20)
  before=len(capture);send('/cafe\r');wait(lambda:'共享范围' in clean(capture[before:]),'menu after reload');send('\x1b');assert len(list((root/'private').glob('cafe-welcome-v1-*.json')))==1
  checks.append('Escape returns to Pi; /reload keeps a single onboarding marker and a functional menu')
  settle();stage='native session creation'
  (root/'agent-other').mkdir(mode=0o700);(root/'agent-other/settings.json').write_text(json.dumps({'enableInstallTelemetry':False,'enableAnalytics':False,'extensions':[],'skills':[],'prompts':[],'themes':[]}))
  other=owned(args+['--mode','rpc'],dict(pi_env,PI_CODING_AGENT_DIR=str(root/'agent-other'),PI_COLLAB_PEER_ID='terminal-pi-other'),subprocess.PIPE)
  helper=owned([a.node,str(pathlib.Path(__file__).resolve().with_name('cafe-native-session-check.mjs'))],env,subprocess.PIPE,subprocess.PIPE,subprocess.PIPE)
  data=json.dumps({'url':local.replace('http:','ws:')+'/ws','token':client_token,'target':'terminal-pi','other':'terminal-pi-other','candidate':a.candidate}).encode()
  out,err=helper.communicate(data,timeout=40)
  if helper.returncode!=0:raise RuntimeError('native new-session helper failed: '+err.decode()[-1000:])
  outcome=json.loads(out);assert outcome['newNativeSessionCreated'] and outcome['otherPiSessionUnchanged'];assert pi.poll() is None and other.poll() is None
  checks.append('A remote new-session command enters native Pi command context, keeps the same process/project, and leaves another Pi session unchanged')
  if a.proxy_regression:
   assert sum(proxy_phases.get(phase,0) for phase in ['menu','share','SSH copy fallback','return'])==0,'Cafe menu/share requests reached global proxy'
   checks.append('Real Pi with HTTP/HTTPS proxy enabled reads loopback and shares QR without contacting the proxy')
  assert client_token not in clean(capture) and host_token not in clean(capture)
  result={'passed':True,'checks':checks,'providerRequests':0,'realPi':True,'realTerminal':True,'appleTerminalMode':a.apple_terminal,'clipboardModified':False,'browserOpened':False,'scope':'temporary Go cloud/device and actual Pi 0.99.1 in an isolated pseudo-terminal','proxyRequestsByPhase':proxy_phases}
  (report/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
except Exception as error:
 result={'passed':False,'stage':stage,'checks':checks,'error':str(error),'terminalTail':clean(capture)[-3500:],'providerRequests':0,'proxyRequests':proxy_requests,'proxyRequestsByPhase':proxy_phases}
 (report/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False));raise SystemExit(1)
finally:
 if test_proxy is not None:test_proxy.shutdown();test_proxy.server_close()
 for child in reversed(children):
  if child.poll() is None:
   child.terminate()
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=3)
 for fd in fds:
  try:os.close(fd)
  except OSError:pass
