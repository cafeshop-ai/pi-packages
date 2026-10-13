import { expect, it } from 'vitest';
import { decodeRoomBase64, roomHash } from './roomCrypto';
import { visitorIdentity, visitorProof, validNickname, rememberNickname, savedNickname } from './visitorIdentity';
const room='B'+'A'.repeat(86),id='c'.repeat(43),nonce='n'.repeat(43);
it('keeps a private non-extractable signing identity and binds the proof to the current connection',async()=>{
 const identity=await visitorIdentity(room);expect(identity.privateKey.extractable).toBe(false);expect(await visitorIdentity(room)).toBe(identity);
 const proof=await visitorProof(identity,room,id,nonce,'拿铁<&>');expect(proof.displayName).toMatch(/^拿铁<&>#[a-f0-9]{8}$/);expect(proof.userId).toMatch(/^visitor-[a-f0-9]{24}$/);
 const publicKey=await crypto.subtle.importKey('raw',decodeRoomBase64(proof.publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 const text=JSON.stringify(['cafe-visitor-v1',room,id,nonce,await roomHash('拿铁<&>'),proof.publicKey]);expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,decodeRoomBase64(proof.signature),new TextEncoder().encode(text))).toBe(true);
 const changed=await visitorProof(identity,room,'d'.repeat(43),nonce,'美式');expect(changed.userId).toBe(proof.userId);expect(changed.displayName.endsWith(proof.displayName.slice(-9))).toBe(true);expect(JSON.stringify(proof)).not.toMatch(/privateKey|password/);
});
it('nickname is a display preference, not an identity credential',()=>{for(const name of['',' a','x#id','x\n','x\u202e','\ud800','字'.repeat(25)])expect(validNickname(name)).toBe(false);expect(validNickname('拿铁')).toBe(true);rememberNickname(room,'美式');expect(savedNickname(room)).toBe('美式');rememberNickname(room,'x#fake');expect(savedNickname(room)).toBe('美式');});
