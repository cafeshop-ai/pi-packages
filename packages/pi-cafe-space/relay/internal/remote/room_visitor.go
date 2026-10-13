package remote

import (
 "errors"
 "strings"
 "unicode"
 "unicode/utf8"
)

type visitorProof struct { PublicKey string `json:"publicKey"`; Signature string `json:"signature"` }
func visitorNicknameValid(name string)bool{
 if !utf8.ValidString(name)||utf8.RuneCountInString(name)<1||utf8.RuneCountInString(name)>24||strings.TrimSpace(name)!=name||strings.Contains(name,"#"){return false}
 for _,r:=range name{if unicode.IsControl(r)||unicode.Is(unicode.Cf,r){return false}}
 return true
}
// Only a password-authenticated, channel-bound signature establishes a stable
// identity. A nickname or caller-supplied identifier cannot restore a grant.
func verifiedRoomVisitor(current Identity,roomKey,nonce,name string,proof *visitorProof)(Identity,error){
 if proof==nil {if name!=""{return current,errors.New("visitor proof required")};return current,nil}
 if !visitorNicknameValid(name)||!roomVerify(proof.PublicKey,proof.Signature,"cafe-visitor-v1",roomKey,current.ID,nonce,roomDigest(name),proof.PublicKey){return current,errors.New("invalid visitor proof")}
 digest:=roomDigest(roomKey+":"+proof.PublicKey)
 current.UserID="visitor-"+digest[:24];current.Name=name+"#"+digest[:8];current.Verified=true
 return current,nil
}
