package service

import (
 "bytes"
 "context"
 "crypto/rand"
 "crypto/subtle"
 "encoding/base64"
 "encoding/json"
 "errors"
 "io"
 "mime"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "runtime"
 "strconv"
 "sync"
 "time"

 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/config"
 "github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/httpserver"
)

// These credentials belong to the OS user. They are never served by HTTP.
// A separate random host key prevents a browser access token impersonating Pi.
type localCredentials struct {
 Version int `json:"version"`
 Port int `json:"port"`
 HostToken string `json:"hostToken"`
 ClientToken string `json:"clientToken"`
}
type localSetup struct {
 mu sync.RWMutex
 cfg config.Config
 options Options
 base http.Handler
 child *Service
 nonce string
 closing bool
 attempts int
 window time.Time
}
func randomSetupToken() (string,error) {
 b:=make([]byte,32); if _,err:=rand.Read(b);err!=nil{return "",err}
 return base64.RawURLEncoding.EncodeToString(b),nil
}
func readLocalCredentials(path string,port int)(*localCredentials,error) {
 info,err:=os.Lstat(path)
 if errors.Is(err,os.ErrNotExist){return nil,nil}; if err!=nil{return nil,err}
 if !info.Mode().IsRegular()||info.Size()>16384||runtime.GOOS!="windows"&&info.Mode().Perm()&0077!=0{return nil,errors.New("Café Space credentials must be a private regular file")}
 f,err:=os.Open(path);if err!=nil{return nil,err};defer f.Close()
 actual,err:=f.Stat();if err!=nil||!os.SameFile(info,actual){return nil,errors.New("Café Space credential file changed")}
 raw,err:=io.ReadAll(io.LimitReader(f,16385));if err!=nil||len(raw)>16384{return nil,errors.New("Invalid Café Space credential file")}
 var value localCredentials
 d:=json.NewDecoder(bytes.NewReader(raw));d.DisallowUnknownFields()
 if d.Decode(&value)!=nil||d.Decode(new(any))!=io.EOF||value.Version!=1||value.Port!=port||!config.ValidSetupHostToken(value.HostToken)||!config.ValidStoredSetupToken(value.ClientToken)||value.HostToken==value.ClientToken{return nil,errors.New("Invalid Café Space credential file; refusing default credentials")}
 return &value,nil
}
func saveLocalCredentials(path string,value localCredentials)error {
 parent:=filepath.Dir(path)
 if err:=os.MkdirAll(parent,0700);err!=nil{return err}
 info,err:=os.Lstat(parent);if err!=nil{return err}
 if !info.IsDir()||info.Mode()&os.ModeSymlink!=0||runtime.GOOS!="windows"&&info.Mode().Perm()&0077!=0{return errors.New("Café Space credential directory must be private")}
 f,err:=os.CreateTemp(parent,".credentials-*");if err!=nil{return err}
 defer os.Remove(f.Name())
 if err=json.NewEncoder(f).Encode(value);err==nil{err=f.Sync()};closeErr:=f.Close();if err!=nil{return err};if closeErr!=nil{return closeErr}
 // Publish a complete file exclusively. A competing first initializer cannot
 // overwrite another credential file; a crash cannot expose partial JSON.
 return os.Link(f.Name(),path)
}
func newLocalSetup(cfg config.Config,options Options)(*Service,error) {
 ip:=net.ParseIP(cfg.Host)
 if cfg.Host!="localhost"&&(ip==nil||!ip.IsLoopback())||!filepath.IsAbs(cfg.CredentialsFile)||cfg.RemoteConfig!=""||cfg.ManagedConfig!=""||!config.NeedsLocalSetup(cfg){return nil,errors.New("Web initialization requires a local unconfigured relay")}
 nonce,err:=randomSetupToken();if err!=nil{return nil,err}
 l:=&localSetup{cfg:cfg,options:options,nonce:nonce,base:httpserver.NewManagedHandler(options.Assets,nil,nil)}
 value,err:=readLocalCredentials(cfg.CredentialsFile,cfg.Port);if err!=nil{return nil,err}
 if value!=nil{l.child,err=l.makeChild(*value);if err!=nil{return nil,err}}
 ctx,cancel:=context.WithCancel(context.Background())
 return &Service{local:l,ctx:ctx,cancel:cancel,done:make(chan struct{}),HTTP:httpserver.NewServer(l)},nil
}
func(l *localSetup)makeChild(value localCredentials)(*Service,error) {
 c:=l.cfg;c.CredentialsFile="";c.HostToken=value.HostToken;c.ClientToken=value.ClientToken;c.DevelopmentCredentials=false
 return New(c,l.options)
}
func(l *localSetup)close(ctx context.Context)error {
 l.mu.Lock();l.closing=true;child:=l.child;l.mu.Unlock()
 if child!=nil{return child.Close(ctx)};return nil
}
func(l *localSetup)localRequest(r *http.Request)bool {
 peer,_,err:=net.SplitHostPort(r.RemoteAddr);if err!=nil{return false}
 ip:=net.ParseIP(peer);if ip==nil||!ip.IsLoopback(){return false}
 host,port,err:=net.SplitHostPort(r.Host);if err!=nil||port!=strconv.Itoa(l.cfg.Port){return false}
 // Literal Host validation prevents DNS rebinding; forwarded headers are ignored.
 if host!="localhost"&&host!="127.0.0.1"&&host!="::1"{return false}
 scheme:="http";if r.TLS!=nil{scheme="https"}
 origins:=r.Header.Values("Origin")
 return len(origins)==0||len(origins)==1&&origins[0]==scheme+"://"+r.Host
}
func setupReply(w http.ResponseWriter,status int,value any){w.Header().Set("Content-Type","application/json; charset=utf-8");w.WriteHeader(status);_ = json.NewEncoder(w).Encode(value)}
func setupError(w http.ResponseWriter,status int,code string){setupReply(w,status,map[string]string{"error":code})}
func(l *localSetup)ServeHTTP(w http.ResponseWriter,r *http.Request) {
 w.Header().Set("Cache-Control","no-store");w.Header().Set("X-Content-Type-Options","nosniff");w.Header().Set("Referrer-Policy","no-referrer");w.Header().Set("X-Frame-Options","DENY")
 w.Header().Set("Content-Security-Policy","default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
 if !l.localRequest(r){setupError(w,403,"LOCAL_ACCESS_REQUIRED");return}
 if r.URL.RawPath!=""||r.URL.RawQuery!=""||r.URL.EscapedPath()!=r.URL.Path{setupError(w,400,"INVALID_REQUEST");return}
 if r.URL.Path=="/api/setup"{l.setup(w,r);return}
 l.mu.RLock();child,closing:=l.child,l.closing;l.mu.RUnlock()
 if closing{setupError(w,503,"SHUTTING_DOWN");return}
 if child!=nil{child.HTTP.Handler.ServeHTTP(w,r);return}
 if r.URL.Path=="/api/config"&&(r.Method=="GET"||r.Method=="HEAD") {
  if r.Method=="HEAD"{w.WriteHeader(200);return}
  setupReply(w,200,map[string]any{"protocolVersion":1,"wsPath":"/ws","defaultRoom":"main","setupRequired":true});return
 }
 if r.URL.Path=="/ws"||r.URL.Path=="/api/workspace"{setupError(w,423,"SETUP_REQUIRED");return}
 l.base.ServeHTTP(w,r)
}
func(l *localSetup)setup(w http.ResponseWriter,r *http.Request) {
 site:=r.Header.Get("Sec-Fetch-Site")
 if site!=""&&site!="same-origin"&&site!="none"{setupError(w,403,"ORIGIN_DENIED");return}
 if r.Method=="GET" {
  if r.Header.Get("X-Cafe-Setup")!="1"{setupError(w,403,"SETUP_HEADER_REQUIRED");return}
  l.mu.RLock();defer l.mu.RUnlock()
  if l.closing{setupError(w,503,"SHUTTING_DOWN");return}
  result:=map[string]any{"required":l.child==nil};if l.child==nil{result["nonce"]=l.nonce}
  setupReply(w,200,result);return
 }
 if r.Method!="POST"{w.Header().Set("Allow","GET, POST");setupError(w,405,"METHOD_NOT_ALLOWED");return}
 if len(r.Header.Values("Origin"))!=1||len(r.Header.Values("X-Cafe-Setup"))!=1{setupError(w,403,"ORIGIN_DENIED");return}
 media,_,err:=mime.ParseMediaType(r.Header.Get("Content-Type"));if err!=nil||media!="application/json"{setupError(w,415,"JSON_REQUIRED");return}
 l.mu.Lock();defer l.mu.Unlock()
 if l.closing{setupError(w,503,"SHUTTING_DOWN");return}
 if l.child!=nil{setupError(w,409,"ALREADY_INITIALIZED");return}
 if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Cafe-Setup")),[]byte(l.nonce))!=1{setupError(w,403,"INVALID_SETUP_CHALLENGE");return}
 if time.Since(l.window)>time.Minute{l.window=time.Now();l.attempts=0};l.attempts++;if l.attempts>30{setupError(w,429,"TOO_MANY_ATTEMPTS");return}
 raw,err:=io.ReadAll(http.MaxBytesReader(w,r.Body,2048));if err!=nil{setupError(w,413,"REQUEST_TOO_LARGE");return}
 // Exactly two unique, case-sensitive keys; no duplicate-key interpretation.
 d:=json.NewDecoder(bytes.NewReader(raw));first,err:=d.Token();if err!=nil||first!=json.Delim('{'){setupError(w,400,"INVALID_REQUEST");return}
 values:=map[string]string{}
 for d.More(){key,e:=d.Token();name,ok:=key.(string);if e!=nil||!ok||(name!="token"&&name!="confirmToken"){setupError(w,400,"INVALID_REQUEST");return};if _,duplicate:=values[name];duplicate{setupError(w,400,"INVALID_REQUEST");return};var text string;if d.Decode(&text)!=nil{setupError(w,400,"INVALID_REQUEST");return};values[name]=text}
 end,err:=d.Token();if err!=nil||end!=json.Delim('}')||d.Decode(new(any))!=io.EOF||len(values)!=2{setupError(w,400,"INVALID_REQUEST");return}
 if values["token"]!=values["confirmToken"]{setupError(w,400,"TOKEN_MISMATCH");return}
 if !config.ValidSetupToken(values["token"]){setupError(w,400,"INVALID_TOKEN");return}
 host,err:=randomSetupToken();if err!=nil{setupError(w,500,"SETUP_FAILED");return}
 value:=localCredentials{Version:1,Port:l.cfg.Port,HostToken:host,ClientToken:values["token"]}
 child,err:=l.makeChild(value);if err!=nil{setupError(w,500,"SETUP_FAILED");return}
 if err=saveLocalCredentials(l.cfg.CredentialsFile,value);err!=nil {
  ctx,cancel:=context.WithTimeout(context.Background(),time.Second);_ = child.Close(ctx);cancel()
  setupError(w,409,"CREDENTIALS_NOT_SAVED");return
 }
 l.child=child;l.nonce=""
 setupReply(w,201,map[string]bool{"initialized":true})
}
