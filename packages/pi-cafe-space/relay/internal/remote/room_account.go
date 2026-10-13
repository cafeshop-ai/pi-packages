package remote

import (
 "context"
 "crypto/ecdsa"
 "crypto/elliptic"
 "crypto/sha256"
 "crypto/tls"
 "encoding/base64"
 "errors"
 "io"
 "math/big"
 "net/http"
 "regexp"
 "strings"
 "sync"
 "time"
)

var accountHashPattern=regexp.MustCompile(`^[a-f0-9]{64}$`)
var accountKeyIDPattern=regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var errAccountIdentity=errors.New("account identity verification failed")
type accountClaims struct {
 Issuer string `json:"iss"`; Audience string `json:"aud"`; Subject string `json:"sub"`
 ID string `json:"jti"`; Issued int64 `json:"iat"`; Expires int64 `json:"exp"`
 Name string `json:"name"`; DisplayID string `json:"display_id"`; Session string `json:"sid"`
 RoomHash string `json:"room_hash"`; Connection string `json:"connection_id"`; Nonce string `json:"nonce"`; PublicKey string `json:"public_key"`
}
type accountVerifier struct { issuer string; client *http.Client; mu sync.Mutex; keys map[string]*ecdsa.PublicKey; fetched,attempted time.Time }
func newAccountVerifier(issuer string)*accountVerifier{
 if issuer==""{return nil}
 return &accountVerifier{issuer:issuer,client:&http.Client{Timeout:4*time.Second,CheckRedirect:func(*http.Request,[]*http.Request)error{return errors.New("identity key redirect rejected")},Transport:&http.Transport{TLSClientConfig:&tls.Config{MinVersion:tls.VersionTLS12},MaxIdleConns:2,MaxIdleConnsPerHost:2,IdleConnTimeout:time.Minute,ResponseHeaderTimeout:3*time.Second,MaxResponseHeaderBytes:8192}}}
}
func accountDecode(value string,max int)([]byte,error){
 if len(value)==0||len(value)>max*2||strings.ContainsAny(value,"=+ /\r\n\t"){return nil,errAccountIdentity};b,e:=base64.RawURLEncoding.DecodeString(value);if e!=nil||len(b)>max||base64.RawURLEncoding.EncodeToString(b)!=value{return nil,errAccountIdentity};return b,nil
}
func(v *accountVerifier)key(ctx context.Context,kid string)(*ecdsa.PublicKey,error){
 v.mu.Lock();defer v.mu.Unlock();now:=time.Now()
 if key:=v.keys[kid];key!=nil&&now.Sub(v.fetched)<2*time.Minute{return key,nil}
 if now.Sub(v.attempted)<time.Second{return nil,errAccountIdentity};v.attempted=now
 req,e:=http.NewRequestWithContext(ctx,"GET",v.issuer+"/jwks",nil);if e!=nil{return nil,errAccountIdentity};req.Header.Set("Accept","application/json")
 response,e:=v.client.Do(req);if e!=nil{return nil,errAccountIdentity};defer response.Body.Close()
 if response.StatusCode!=200||!strings.HasPrefix(response.Header.Get("Content-Type"),"application/json"){return nil,errAccountIdentity}
 raw,e:=io.ReadAll(io.LimitReader(response.Body,16385));if e!=nil||len(raw)>16384{return nil,errAccountIdentity}
 var document struct{Keys []struct{Kty string `json:"kty"`;Crv string `json:"crv"`;X string `json:"x"`;Y string `json:"y"`;Kid string `json:"kid"`;Alg string `json:"alg"`;Use string `json:"use"`} `json:"keys"`}
 if strictJSON(raw,&document)!=nil||len(document.Keys)==0||len(document.Keys)>4{return nil,errAccountIdentity}
 parsed:=map[string]*ecdsa.PublicKey{}
 for _,j:=range document.Keys{
  if j.Kty!="EC"||j.Crv!="P-256"||j.Alg!="ES256"||j.Use!="sig"||!accountKeyIDPattern.MatchString(j.Kid)||parsed[j.Kid]!=nil{return nil,errAccountIdentity}
  x,xe:=accountDecode(j.X,32);y,ye:=accountDecode(j.Y,32);if xe!=nil||ye!=nil||len(x)!=32||len(y)!=32{return nil,errAccountIdentity}
  key:=&ecdsa.PublicKey{Curve:elliptic.P256(),X:new(big.Int).SetBytes(x),Y:new(big.Int).SetBytes(y)};if !key.Curve.IsOnCurve(key.X,key.Y){return nil,errAccountIdentity};parsed[j.Kid]=key
 }
 v.keys=parsed;v.fetched=now;if parsed[kid]==nil{return nil,errAccountIdentity};return parsed[kid],nil
}
// Only verifies this application's constrained ES256 assertion. OIDC itself
// is implemented by the dedicated standards-based provider/client service.
func(v *accountVerifier)verify(ctx context.Context,token,room,id,nonce,public string)(accountClaims,error){
 var result accountClaims;if v==nil||len(token)>6144{return result,errAccountIdentity};parts:=strings.Split(token,".");if len(parts)!=3{return result,errAccountIdentity}
 header,e:=accountDecode(parts[0],512);if e!=nil{return result,e};var h struct{Alg string `json:"alg"`;Kid string `json:"kid"`;Type string `json:"typ"`}
 if strictJSON(header,&h)!=nil||h.Alg!="ES256"||h.Type!="cafe-account+jwt"||!accountKeyIDPattern.MatchString(h.Kid){return result,errAccountIdentity}
 payload,e:=accountDecode(parts[1],4096);if e!=nil||strictJSON(payload,&result)!=nil{return accountClaims{},errAccountIdentity}
 now:=time.Now().Unix();if result.Issuer!=v.issuer||result.Audience!="cafe-space-room"||!accountHashPattern.MatchString(result.Subject)||!tokenPattern.MatchString(result.ID)||!tokenPattern.MatchString(result.Session)||result.Issued>now+5||result.Issued<now-65||result.Expires<=now||result.Expires-result.Issued>60||result.Expires<=result.Issued||!visitorNicknameValid(result.Name)||result.DisplayID!=result.Subject[:8]||result.RoomHash!=roomDigest(room)||result.Connection!=id||result.Nonce!=nonce||result.PublicKey!=public{return accountClaims{},errAccountIdentity}
 signature,e:=accountDecode(parts[2],64);if e!=nil||len(signature)!=64{return accountClaims{},errAccountIdentity};key,e:=v.key(ctx,h.Kid);if e!=nil{return accountClaims{},e};digest:=sha256.Sum256([]byte(parts[0]+"."+parts[1]))
 if !ecdsa.Verify(key,digest[:],new(big.Int).SetBytes(signature[:32]),new(big.Int).SetBytes(signature[32:])){return accountClaims{},errAccountIdentity}
 return result,nil
}
func accountIdentity(current Identity,claims accountClaims,room string)Identity{
 // Stable account label, but grants remain scoped to this browser key AND this
 // app login session. A different device/login cannot inherit an old grant.
 current.UserID="account-"+roomDigest(claims.Subject+":"+claims.Session+":"+room+":"+claims.PublicKey)[:24]
 current.Name=claims.Name+"#"+claims.DisplayID;current.Kind="account";current.AccountID=claims.Subject;current.Verified=true;return current
}
func(s *remoteSession)renewAccount(raw []byte)error{
 var q struct{Type string `json:"type"`;Assertion string `json:"assertion"`};if len(raw)>8192||strictJSON(raw,&q)!=nil||q.Type!="room.account.renew"{return errAccountIdentity}
 s.mu.Lock();sub,sid,key,last:=s.accountSubject,s.accountSession,s.accountPublicKey,s.accountChecked;s.mu.Unlock()
 if sub==""||time.Since(last)<5*time.Second{return errAccountIdentity}
 claims,e:=s.agent.accounts.verify(s.agent.ctx,q.Assertion,s.roomKey,s.identity.ID,s.browserNonce,key);if e!=nil||claims.Subject!=sub||claims.Session!=sid{return errAccountIdentity}
 s.mu.Lock();defer s.mu.Unlock();if s.closed{return errClosed};s.accountUntil=time.Unix(claims.Expires,0);s.accountChecked=time.Now();return nil
}
