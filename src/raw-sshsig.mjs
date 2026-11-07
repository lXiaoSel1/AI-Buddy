import {createHash, createPublicKey, verify as verifySignature} from 'node:crypto';

function fail(message) { throw new Error(message); }
function binaryReader(bytes) {
  let position = 0;
  const raw = n => { if (!Number.isSafeInteger(n) || n < 0 || position + n > bytes.length) fail('Truncated SSH signature', 'PLUGIN_SIGNATURE_INVALID'); const result = bytes.subarray(position, position + n); position += n; return result; };
  const uint32 = () => raw(4).readUInt32BE(0);
  return {raw, uint32, field() { const length = uint32(); if (length > 1024 * 1024) fail('SSH field exceeds limit', 'PLUGIN_SIGNATURE_INVALID'); return raw(length); }, end: () => position === bytes.length};
}
function field(bytes) { const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); }
function strictBase64(value) {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('Invalid base64 signature', 'PLUGIN_SIGNATURE_INVALID');
  return Buffer.from(value, 'base64');
}
function sshPublicKey(openssh) {
  const parts = openssh.trim().split(/\s+/);
  if (parts[0] !== 'ssh-ed25519' || !parts[1]) fail('Only Ed25519 trust keys are supported', 'PLUGIN_SIGNATURE_INVALID');
  const blob = strictBase64(parts[1]), reader = binaryReader(blob);
  if (reader.field().toString() !== 'ssh-ed25519') fail('Invalid SSH public key', 'PLUGIN_SIGNATURE_INVALID');
  const raw = reader.field();
  if (!reader.end() || raw.length !== 32) fail('Invalid SSH public key', 'PLUGIN_SIGNATURE_INVALID');
  return {blob, key: createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki', format: 'der'})};
}
function trustKey(value) {
  if (typeof value === 'string' && value.startsWith('ssh-ed25519 ')) return sshPublicKey(value).key;
  const key = value?.type === 'public' ? value : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') fail('Only Ed25519 trust keys are supported', 'PLUGIN_SIGNATURE_INVALID');
  return key;
}
function verifySshSignature(message, armored, trusted, expectedNamespace) {
  if (typeof armored !== 'string' || armored.length > 16000) return false;
  const match = /^-----BEGIN SSH SIGNATURE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END SSH SIGNATURE-----\r?\n?$/.exec(armored);
  if (!match) return false;
  const reader = binaryReader(strictBase64(match[1].replace(/\s/g, '')));
  if (reader.raw(6).toString() !== 'SSHSIG' || reader.uint32() !== 1) return false;
  const signer = reader.field(), namespace = reader.field(), reserved = reader.field(), hashName = reader.field(), signed = reader.field();
  if (!reader.end() || namespace.toString() !== expectedNamespace || reserved.length || !['sha256', 'sha512'].includes(hashName.toString())) return false;
  const signerKey = sshPublicKey('ssh-ed25519 ' + signer.toString('base64')).key;
  const key = trustKey(trusted);
  if (!key.export({format: 'der', type: 'spki'}).equals(signerKey.export({format: 'der', type: 'spki'}))) return false;
  const signatureReader = binaryReader(signed);
  if (signatureReader.field().toString() !== 'ssh-ed25519') return false;
  const signature = signatureReader.field();
  if (!signatureReader.end() || signature.length !== 64) return false;
  const digest = createHash(hashName.toString()).update(message).digest();
  const data = Buffer.concat([Buffer.from('SSHSIG'), field(namespace), field(reserved), field(hashName), field(digest)]);
  return verifySignature(null, data, key, signature);
}


// The caller owns the exact bytes and trust root; this layer never canonicalizes JSON.
export function verifyRawSshSignature(message, armored, trusted, namespace) {
  try { return typeof namespace === 'string' && !!namespace && verifySshSignature(message, armored, trusted, namespace); } catch { return false; }
}
export function verifyRawEd25519Signature(message, encoded, trusted) {
  try { const bytes = strictBase64(encoded); return bytes.length === 64 && verifySignature(null, message, trustKey(trusted), bytes); } catch { return false; }
}
