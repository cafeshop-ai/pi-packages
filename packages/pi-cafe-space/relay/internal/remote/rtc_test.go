package remote

import (
	"bytes"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"github.com/pion/turn/v5"
	"github.com/pion/webrtc/v4"
)

func TestDataChannelFramingLimits(t *testing.T) {
	input:=bytes.Repeat([]byte{0,1,254,255},protocol.MaxFrameBytes/4)
	var decoder chunkDecoder;var result []byte
	for offset:=0;offset<len(input);offset+=rtcPacketBytes-rtcHeaderBytes{packet:=chunkPacket(1,input,offset);if len(packet)>rtcPacketBytes{t.Fatal("oversized packet")};var err error;result,err=decoder.push(packet,time.Unix(0,0));if err!=nil{t.Fatal(err)}}
	if !bytes.Equal(input,result){t.Fatal("message changed during chunking")}
	if _,err:=decoder.push(chunkPacket(1,[]byte("replay"),0),time.Unix(1,0));err==nil{t.Fatal("replay accepted")}
	for _,raw:=range [][]byte{nil,{0},{1,2,3},make([]byte,rtcPacketBytes+1)}{var d chunkDecoder;if _,err:=d.push(raw,time.Now());err==nil{t.Fatal("invalid frame accepted")}}
	var stale chunkDecoder;large:=make([]byte,20000);if _,err:=stale.push(chunkPacket(1,large,0),time.Unix(0,0));err!=nil{t.Fatal(err)}
	if _,err:=stale.push(chunkPacket(1,large,rtcPacketBytes-rtcHeaderBytes),time.Unix(11,0));err==nil{t.Fatal("expired assembly accepted")}
}
func FuzzChunkDecoder(f *testing.F){
	f.Add(chunkPacket(1,[]byte("bounded fixture"),0));f.Add([]byte("invalid"))
	f.Fuzz(func(t *testing.T,raw []byte){var d chunkDecoder;_,_ = d.push(raw,time.Unix(0,0));if cap(d.data)>protocol.MaxFrameBytes{t.Fatal("unbounded allocation")}})
}
func TestStrictRemoteJSON(t *testing.T){
	for _,raw:=range []string{`{"type":"a","type":"b"}`,`{"type":"a","TYPE":"b"}`,`{"type":"a","x":{"id":"a","id":"b"}}`,`{} {}`,strings.Repeat("[",65)+"0"+strings.Repeat("]",65)}{if uniqueJSON([]byte(raw))==nil{t.Fatal("ambiguous JSON accepted")}}
}
func localTURN(t *testing.T)ICEServer{
	t.Helper();listener,err:=net.ListenPacket("udp4","127.0.0.1:0");if err!=nil{t.Fatal(err)}
	key,err:=NewToken();if err!=nil{listener.Close();t.Fatal(err)}
	server,err:=turn.NewServer(turn.ServerConfig{
		Realm:"pi-cafe-test",AuthHandler:func(ra *turn.RequestAttributes)(string,[]byte,bool){if ra.Username!="fixture"||ra.Realm!="pi-cafe-test"{return "",nil,false};return ra.Username,turn.GenerateAuthKey(ra.Username,ra.Realm,key),true},
		PacketConnConfigs:[]turn.PacketConnConfig{{PacketConn:listener,RelayAddressGenerator:&turn.RelayAddressGeneratorStatic{RelayAddress:net.ParseIP("127.0.0.1"),Address:"127.0.0.1"},PermissionHandler:func(_ net.Addr,peerIP net.IP)bool{return peerIP.IsLoopback()}}},
	})
	if err!=nil{listener.Close();t.Fatal(err)};t.Cleanup(func(){_ = server.Close();_ = listener.Close()})
	return ICEServer{URLs:[]string{"turn:"+listener.LocalAddr().String()+"?transport=udp"},Username:"fixture",Credential:key}
}
func TestWebRTCEndToEndDirectAndTURN(t *testing.T){
	for _,relayOnly:=range []bool{false,true}{name:="direct";if relayOnly{name="forced-turn"};t.Run(name,func(t *testing.T){
		f:=fixture(t)
		var servers []ICEServer
		if relayOnly{servers=[]ICEServer{localTURN(t)};cfg:=f.cfg;cfg.ICEServers=servers;if err:=f.cloud.Reload(cfg);err!=nil{t.Fatal(err)}}
		browser:=f.connect(t,"operator","webrtc")
		configuration:=rtcConfiguration(servers);if relayOnly{configuration.ICETransportPolicy=webrtc.ICETransportPolicyRelay}
		pc,err:=newRTCAPI().NewPeerConnection(configuration);if err!=nil{t.Fatal(err)};t.Cleanup(func(){_ = pc.Close()})
		protocolName:="pi-cafe-v1";ordered:=true
		dc,err:=pc.CreateDataChannel(protocolName,&webrtc.DataChannelInit{Protocol:&protocolName,Ordered:&ordered});if err!=nil{t.Fatal(err)}
		opened:=make(chan struct{});var openOnce sync.Once;dc.OnOpen(func(){openOnce.Do(func(){close(opened)})})
		incoming:=make(chan map[string]any,128);failures:=make(chan error,1);var decoder chunkDecoder;var receiveMu sync.Mutex
		dc.OnMessage(func(message webrtc.DataChannelMessage){receiveMu.Lock();defer receiveMu.Unlock();raw,err:=decoder.push(message.Data,time.Now());if err!=nil{select{case failures<-err:default:};return};if raw==nil{return};var value map[string]any;if err=json.Unmarshal(raw,&value);err!=nil{select{case failures<-err:default:};return};select{case incoming<-value:default:}})
		offer,err:=pc.CreateOffer(nil);if err!=nil{t.Fatal(err)};gathered:=webrtc.GatheringCompletePromise(pc)
		if err=pc.SetLocalDescription(offer);err!=nil{t.Fatal(err)}
		select{case<-gathered:case<-time.After(8*time.Second):t.Fatal("offer gather timeout")}
		browser.send(Frame{Type:"offer",ID:browser.opened.ID,SDP:pc.LocalDescription().SDP})
		answer:=browser.outer("answer");if err=pc.SetRemoteDescription(webrtc.SessionDescription{Type:webrtc.SDPTypeAnswer,SDP:answer.SDP});err!=nil{t.Fatal(err)}
		select{case<-opened:case<-time.After(8*time.Second):t.Fatal("DataChannel did not open")}
		browser.send(Frame{Type:"select",ID:browser.opened.ID,Mode:"webrtc"});if browser.outer("selected").Mode!="webrtc"{t.Fatal("wrong transport")}
		pair,err:=pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair();if err!=nil||pair==nil{t.Fatal("missing observed candidate pair",err)}
		if relayOnly&&pair.Local.Typ!=webrtc.ICECandidateTypeRelay{t.Fatal("TURN test did not actually select TURN")}
		if !relayOnly&&(pair.Local.Typ==webrtc.ICECandidateTypeRelay||pair.Remote.Typ==webrtc.ICECandidateTypeRelay){t.Fatal("direct test used an unexpected relay")}
		var sequence uint32
		send:=func(value any){t.Helper();raw,err:=json.Marshal(value);if err!=nil{t.Fatal(err)};sequence++;for offset:=0;offset<len(raw);offset+=rtcPacketBytes-rtcHeaderBytes{if err:=dc.Send(chunkPacket(sequence,raw,offset));err!=nil{t.Fatal(err)}}}
		receive:=func(kind,id string)map[string]any{t.Helper();deadline:=time.NewTimer(5*time.Second);defer deadline.Stop();for{select{case err:=<-failures:t.Fatal(err);case<-deadline.C:t.Fatal("DataChannel response timeout",kind);case m:=<-incoming:if m["type"]==kind&&(id==""||m["requestId"]==id){return m}}}}
		send(map[string]any{"type":"hello","protocolVersion":1,"peerRole":"client","peerId":"browser","roomId":"main","token":"remote-session"})
		receive("welcome","");status:=receive("host_status","");if len(status["hosts"].([]any))!=2{t.Fatal("missing native Pi instances")};receive("remote.presence","")
		send(control("take-rtc","pi-a","acquire",false));if m:=receive("remote.result","take-rtc");m["ok"]!=true{t.Fatal(m)}
		send(prompt("rtc-write-once","pi-a"));eventually(t,func()bool{return f.host["pi-a"].count("routed_command")==1})
		command:=f.host["pi-a"].last("routed_command");f.native(t,"pi-a",protocol.Object{"type":"host_command_result","relayRequestId":command["relayRequestId"],"status":"dispatched","code":nil,"message":nil})
		if m:=receive("command_result","rtc-write-once");m["status"]!="dispatched"{t.Fatal(m)}
		if f.host["pi-b"].count("routed_command")!=0{t.Fatal("wrong Pi controlled")}
		// Revocation travels over signalling even while business data is direct.
		copyBytes,_:=json.Marshal(f.cfg);var revoked Config;_ = json.Unmarshal(copyBytes,&revoked);for i:=range revoked.Users{if revoked.Users[i].ID=="operator"{revoked.Users[i].Disabled=true}}
		if err:=f.cloud.Reload(revoked);err!=nil{t.Fatal(err)}
		eventually(t,func()bool{return dc.ReadyState()==webrtc.DataChannelStateClosed})
		if f.host["pi-a"].count("routed_command")!=1{t.Fatal("replayed business command")}
	})}
}
