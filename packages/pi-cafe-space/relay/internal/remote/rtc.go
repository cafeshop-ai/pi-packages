package remote

import (
	"encoding/binary"
	"errors"
	"sync"
	"strings"
	"time"

	"github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay/internal/protocol"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

const rtcPacketBytes = 16*1024
const rtcHeaderBytes = 16
const rtcMagic uint32 = 0x50434431 // PCD1

type chunkDecoder struct{last,id uint32;total int;data []byte;deadline time.Time}
func(d *chunkDecoder) push(packet []byte,now time.Time)([]byte,error){
	if len(packet)<=rtcHeaderBytes||len(packet)>rtcPacketBytes||binary.BigEndian.Uint32(packet)!=rtcMagic{return nil,errors.New("invalid DataChannel packet")}
	id:=binary.BigEndian.Uint32(packet[4:]);total:=int(binary.BigEndian.Uint32(packet[8:]));offset:=int(binary.BigEndian.Uint32(packet[12:]));body:=packet[16:]
	if id==0||total<1||total>protocol.MaxFrameBytes||offset<0||offset+len(body)>total{return nil,errors.New("invalid DataChannel bounds")}
	if offset==0{next:=d.last+1;if next==0{next=1};if d.data!=nil||id!=next{return nil,errors.New("overlapping or replayed DataChannel message")};d.id=id;d.total=total;d.data=make([]byte,0,total);d.deadline=now.Add(10*time.Second)}
	if d.data==nil||id!=d.id||total!=d.total||offset!=len(d.data)||now.After(d.deadline){return nil,errors.New("DataChannel sequence or timeout")}
	d.data=append(d.data,body...);if len(d.data)<d.total{return nil,nil};result:=d.data;d.data=nil;d.last=id;return result,nil
}
func chunkPacket(id uint32,raw []byte,offset int)[]byte{end:=offset+rtcPacketBytes-rtcHeaderBytes;if end>len(raw){end=len(raw)};b:=make([]byte,rtcHeaderBytes+end-offset);binary.BigEndian.PutUint32(b,rtcMagic);binary.BigEndian.PutUint32(b[4:],id);binary.BigEndian.PutUint32(b[8:],uint32(len(raw)));binary.BigEndian.PutUint32(b[12:],uint32(offset));copy(b[16:],raw[offset:end]);return b}

type rtcPeer struct{
	pc *webrtc.PeerConnection
	mu sync.Mutex
	dc *webrtc.DataChannel
	receiveMu sync.Mutex
	decoder chunkDecoder
	sendMu sync.Mutex
	next uint32
	low chan struct{}
	done chan struct{}
	once sync.Once
}
func newRTCAPI(attempts ...*rtcAttempt)*webrtc.API{var settings webrtc.SettingEngine;if len(attempts)>0&&attempts[0]!=nil{settings.LoggerFactory=rtcTraceLoggerFactory{attempts[0]}};settings.SetSCTPMaxMessageSize(rtcPacketBytes);settings.SetSCTPMaxReceiveBufferSize(512*1024);settings.SetSTUNGatherTimeout(5*time.Second);settings.SetICETimeouts(8*time.Second,15*time.Second,2*time.Second);settings.SetIncludeLoopbackCandidate(true);return webrtc.NewAPI(webrtc.WithSettingEngine(settings))}
func rtcConfiguration(servers []ICEServer)webrtc.Configuration{cfg:=webrtc.Configuration{};for _,s:=range servers{cfg.ICEServers=append(cfg.ICEServers,webrtc.ICEServer{URLs:s.URLs,Username:s.Username,Credential:s.Credential})};return cfg}
func(p *rtcPeer) ready()bool{p.mu.Lock();defer p.mu.Unlock();return p.dc!=nil&&p.dc.ReadyState()==webrtc.DataChannelStateOpen}
func(p *rtcPeer) close(){p.once.Do(func(){close(p.done);_ = p.pc.Close()})}
func(p *rtcPeer) send(raw []byte)error{
	p.sendMu.Lock();defer p.sendMu.Unlock();p.mu.Lock();dc:=p.dc;p.mu.Unlock();if dc==nil||dc.ReadyState()!=webrtc.DataChannelStateOpen{return errClosed}
	p.next++;if p.next==0{p.next=1}
	for offset:=0;offset<len(raw);offset+=rtcPacketBytes-rtcHeaderBytes{
		deadline:=time.NewTimer(5*time.Second)
		for dc.BufferedAmount()>256*1024{select{case<-p.done:deadline.Stop();return errClosed;case<-p.low:case<-deadline.C:return errors.New("DataChannel send budget timeout")}}
		deadline.Stop();select{case<-p.done:return errClosed;default:}
		if err:=dc.Send(chunkPacket(p.next,raw,offset));err!=nil{return err}
	}
	return nil
}
func(s *remoteSession) acceptRTCDataChannel(p *rtcPeer,dc *webrtc.DataChannel){
 s.trace.add("data","received")
 if dc.Label()!="pi-cafe-v1"{s.trace.add("policy","LABEL_REJECTED")}else if dc.Protocol()!="pi-cafe-v1"{s.trace.add("policy","PROTOCOL_REJECTED")}else if !dc.Ordered()||dc.MaxRetransmits()!=nil||dc.MaxPacketLifeTime()!=nil{s.trace.add("policy","RELIABILITY_REJECTED")}
 if dc.Label()!="pi-cafe-v1"||dc.Protocol()!="pi-cafe-v1"||!dc.Ordered()||dc.MaxRetransmits()!=nil||dc.MaxPacketLifeTime()!=nil{_ = dc.Close();s.Close(1008,"Reliable ordered data channel required");return}
 p.mu.Lock();if p.dc!=nil{p.mu.Unlock();_ = dc.Close();s.Close(1008,"Only one data channel is allowed");return};p.dc=dc;p.mu.Unlock()
 dc.SetBufferedAmountLowThreshold(64*1024);dc.OnBufferedAmountLow(func(){select{case p.low<-struct{}{}:default:}})
 dc.OnOpen(func(){s.trace.add("data","open");if err:=s.finishTransportSelection();err!=nil{s.Close(1001,"WebRTC selection interrupted")}})
 dc.OnError(func(err error){s.trace.add("data-error",rtcErrorClass(err))})
 dc.OnClose(func(){s.trace.add("data","closed");if s.isTransport("webrtc"){s.Close(1001,"DataChannel closed")}})
 dc.OnMessage(func(m webrtc.DataChannelMessage){
  if m.IsString||!s.isTransport("webrtc"){s.Close(1008,"Invalid data transport");return}
  p.receiveMu.Lock();raw,err:=p.decoder.push(m.Data,time.Now());p.receiveMu.Unlock()
  if err!=nil{s.Close(1008,"Invalid DataChannel message");return};if raw!=nil&&s.input(raw)!=nil{s.Close(1013,"Remote input queue full")}
 })
}
func(s *remoteSession) offer(text string){
	s.mu.Lock();if s.closed||s.offered||s.chosen!=""||s.mode=="relay"||!s.agent.cfg.EnableWebRTC{s.mu.Unlock();return};s.offered=true;s.mu.Unlock()
	go func(){
		failed:=func(){_ = s.link.Send(Frame{Type:"signal_error",ID:s.identity.ID,Code:"WEBRTC_UNAVAILABLE"})}
		var desc sdp.SessionDescription
		if len(text)==0||len(text)>maxSDPBytes||desc.Unmarshal([]byte(text))!=nil||len(desc.MediaDescriptions)!=1||desc.MediaDescriptions[0].MediaName.Media!="application"{failed();return}
		candidateCount:=0;for _,a:=range desc.MediaDescriptions[0].Attributes{if a.Key=="candidate"{candidateCount++}};if candidateCount>128{failed();return}
		servers:=s.ice;if len(s.agent.cfg.ICEServers)>0{servers=s.agent.cfg.ICEServers}
		pc,err:=newRTCAPI(s.trace).NewPeerConnection(rtcConfiguration(servers));if err!=nil{failed();return}
		p:=&rtcPeer{pc:pc,low:make(chan struct{},1),done:make(chan struct{})}
		if s.trace!=nil {
			pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState){s.trace.add("ice",state.String())})
			if transport:=pc.SCTP();transport!=nil{
				transport.OnError(func(err error){s.trace.add("sctp-error",rtcErrorClass(err))})
				transport.OnClose(func(err error){s.trace.add("sctp-close",rtcErrorClass(err))})
				if dtls:=transport.Transport();dtls!=nil{dtls.OnStateChange(func(state webrtc.DTLSTransportState){s.trace.add("dtls",state.String())})}
			}
		}
		relayReady:=make(chan struct{},1)
		if s.roomKey!="" { pc.OnICECandidate(func(candidate *webrtc.ICECandidate){if candidate!=nil&&candidate.Typ==webrtc.ICECandidateTypeRelay{select{case relayReady<-struct{}{}:default:}}}) }
		s.mu.Lock();if s.closed||s.chosen!=""{s.mu.Unlock();p.close();return};s.rtc=p;s.mu.Unlock()
		pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState){s.trace.add("peer",state.String());if state==webrtc.PeerConnectionStateFailed||state==webrtc.PeerConnectionStateClosed{if s.isTransport("webrtc"){s.Close(1001,"WebRTC connection lost")}else if state==webrtc.PeerConnectionStateFailed{failed()}}})
		pc.OnDataChannel(func(dc *webrtc.DataChannel){s.acceptRTCDataChannel(p,dc)})
		if err=pc.SetRemoteDescription(webrtc.SessionDescription{Type:webrtc.SDPTypeOffer,SDP:text});err!=nil{p.close();failed();return}
		answer,err:=pc.CreateAnswer(nil);if err!=nil{p.close();failed();return}
		complete:=webrtc.GatheringCompletePromise(pc)
		if err=pc.SetLocalDescription(answer);err!=nil{p.close();failed();return}
		timer:=time.NewTimer(8*time.Second);defer timer.Stop()
		gathering:
		for { select {
		case<-s.stop:p.close();return
		case<-p.done:return
		case<-timer.C:local:=pc.LocalDescription();if s.roomKey==""||local==nil||!strings.Contains(local.SDP,"a=candidate:"){p.close();failed();return};break gathering
		case<-complete:break gathering
		case<-relayReady:
			settle:=time.NewTimer(250*time.Millisecond)
			select{case<-s.stop:settle.Stop();p.close();return;case<-p.done:settle.Stop();return;case<-complete:settle.Stop();break gathering;case<-settle.C:}
			local:=pc.LocalDescription();if local!=nil&&strings.Contains(local.SDP," typ relay"){break gathering}
		} }
		s.mu.Lock();active:=!s.closed&&s.chosen=="";s.mu.Unlock();if !active{p.close();return}
		local:=pc.LocalDescription();if local==nil||len(local.SDP)>maxSDPBytes{p.close();failed();return}
		answerFrame:=Frame{Type:"answer",ID:s.identity.ID,SDP:local.SDP}
		if s.roomKey!="" {
			offerHash:=roomDigest(text)
			signature,err:=s.agent.room.sign(s.roomKey,"cafe-room-answer-v1",s.roomKey,s.identity.ID,s.browserNonce,offerHash,roomDigest(local.SDP))
			if err!=nil{p.close();failed();return}
			answerFrame.Signature=signature;answerFrame.PeerID=offerHash
		}
		if s.link.Send(answerFrame)!=nil{p.close()}
	}()
}
