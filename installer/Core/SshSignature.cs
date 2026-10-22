using System.Buffers.Binary;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
namespace AiBuddy.Install;

// Verifies an OpenSSH "SSHSIG" signature, as written by `git tag -s` with gpg.format=ssh,
// against one pinned Ed25519 public key. GitHub's "verified" only says some key of the
// account signed; this checks that the release key did. Verification only, no secrets.
public static class SshSignature {
    public static bool Verify(string message,string armored,string publicKey,string expectedNamespace="git")=>Verify(Encoding.UTF8.GetBytes(message),armored,publicKey,expectedNamespace);
    public static bool Verify(byte[] message,string armored,string publicKey,string expectedNamespace="git") {
        try {
            var pinned=PublicKeyBlob(publicKey);
            var r=new Reader(Unarmor(armored));
            if(!r.Raw(6).AsSpan().SequenceEqual("SSHSIG"u8)||r.UInt32()!=1)return false;
            var signer=r.String();var space=r.String();var reserved=r.String();var hashName=Encoding.ASCII.GetString(r.String());var signatureBlob=r.String();
            if(!r.End||!signer.AsSpan().SequenceEqual(pinned)||Encoding.UTF8.GetString(space)!=expectedNamespace)return false;
            byte[] digest=hashName switch{"sha512"=>SHA512.HashData(message),"sha256"=>SHA256.HashData(message),_=>throw new InvalidDataException("Unsupported SSHSIG hash")};
            var s=new Reader(signatureBlob);if(Encoding.ASCII.GetString(s.String())!="ssh-ed25519")return false;var signature=s.String();
            var k=new Reader(pinned);if(Encoding.ASCII.GetString(k.String())!="ssh-ed25519")return false;var key=k.String();
            if(!s.End||!k.End||signature.Length!=64||key.Length!=32)return false;
            // The signed data is defined by OpenSSH PROTOCOL.sshsig.
            var signed=new List<byte>("SSHSIG"u8.ToArray());
            foreach(var field in new[]{space,reserved,Encoding.ASCII.GetBytes(hashName),digest})signed.AddRange(Field(field));
            return Ed25519.Verify(key,signed.ToArray(),signature);
        } catch(Exception e) when(e is FormatException or InvalidDataException or ArgumentException) {return false;}
    }
    // "ssh-ed25519 AAAA… comment" -> the SSH wire-format key blob.
    public static byte[] PublicKeyBlob(string openssh) {
        var parts=openssh.Trim().Split(' ',StringSplitOptions.RemoveEmptyEntries);
        if(parts.Length<2||parts[0]!="ssh-ed25519")throw new InvalidDataException("The pinned key must be ssh-ed25519");
        return Convert.FromBase64String(parts[1]);
    }
    static byte[] Unarmor(string armored) {
        const string begin="-----BEGIN SSH SIGNATURE-----",end="-----END SSH SIGNATURE-----";
        var text=armored.Replace("\r","");var b=text.IndexOf(begin,StringComparison.Ordinal);var e=text.IndexOf(end,StringComparison.Ordinal);
        if(b!=0||e<b)throw new InvalidDataException("Not an SSH signature");
        return Convert.FromBase64String(string.Concat(text[(b+begin.Length)..e].Split('\n',StringSplitOptions.RemoveEmptyEntries|StringSplitOptions.TrimEntries)));
    }
    static byte[] Field(byte[] value){var length=new byte[4];BinaryPrimitives.WriteUInt32BigEndian(length,(uint)value.Length);return [..length,..value];}
    sealed class Reader(byte[] data) {
        int at;
        public bool End=>at==data.Length;
        public byte[] Raw(int n){if(n<0||at+n>data.Length)throw new InvalidDataException("Truncated SSH signature");var value=data[at..(at+n)];at+=n;return value;}
        public uint UInt32()=>BinaryPrimitives.ReadUInt32BigEndian(Raw(4));
        public byte[] String(){var n=UInt32();if(n>1<<20)throw new InvalidDataException("SSH signature field too large");return Raw((int)n);}
    }
}

// RFC 8032 Ed25519 signature verification with BigInteger arithmetic. Public inputs only,
// so constant time is not needed. Checks [S]B == R + [k]A with S < L.
public static class Ed25519 {
    static readonly BigInteger P=BigInteger.Pow(2,255)-19;
    static readonly BigInteger L=BigInteger.Pow(2,252)+BigInteger.Parse("27742317777372353535851937790883648493",System.Globalization.CultureInfo.InvariantCulture);
    static readonly BigInteger D=Mod(-121665*Inv(121666));
    static readonly BigInteger SqrtMinusOne=BigInteger.ModPow(2,(P-1)/4,P);
    static readonly (BigInteger X,BigInteger Y) BasePoint=Recover(Mod(4*Inv(5)),false)!.Value;

    public static bool Verify(byte[] publicKey,byte[] message,byte[] signature) {
        if(publicKey.Length!=32||signature.Length!=64)return false;
        var a=Decode(publicKey);var r=Decode(signature[..32]);if(a is null||r is null)return false;
        var s=new BigInteger(signature[32..],isUnsigned:true,isBigEndian:false);if(s>=L)return false;
        var k=new BigInteger(SHA512.HashData([..signature[..32],..publicKey,..message]),isUnsigned:true,isBigEndian:false)%L;
        return Encode(Multiply(s,BasePoint)).AsSpan().SequenceEqual(Encode(Add(r.Value,Multiply(k,a.Value))));
    }
    static BigInteger Mod(BigInteger a){var r=a%P;return r.Sign<0?r+P:r;}
    static BigInteger Inv(BigInteger a)=>BigInteger.ModPow(Mod(a),P-2,P);
    // Twisted Edwards addition for -x^2+y^2=1+d*x^2*y^2; also correct for doubling.
    static (BigInteger X,BigInteger Y) Add((BigInteger X,BigInteger Y) a,(BigInteger X,BigInteger Y) b) {
        var t=Mod(D*a.X*b.X%P*a.Y%P*b.Y);
        return (Mod((a.X*b.Y+b.X*a.Y)%P*Inv(1+t)),Mod((a.Y*b.Y+a.X*b.X)%P*Inv(1-t)));
    }
    static (BigInteger X,BigInteger Y) Multiply(BigInteger scalar,(BigInteger X,BigInteger Y) point) {
        (BigInteger X,BigInteger Y) result=(BigInteger.Zero,BigInteger.One);
        while(scalar>0){if(!scalar.IsEven)result=Add(result,point);point=Add(point,point);scalar>>=1;}
        return result;
    }
    static (BigInteger X,BigInteger Y)? Decode(byte[] encoded) {
        var bytes=(byte[])encoded.Clone();var odd=(bytes[31]&0x80)!=0;bytes[31]&=0x7f;
        var y=new BigInteger(bytes,isUnsigned:true,isBigEndian:false);return y>=P?null:Recover(y,odd);
    }
    static (BigInteger X,BigInteger Y)? Recover(BigInteger y,bool odd) {
        var u=Mod(y*y-1);var v=Mod(D*y*y+1);
        var x=Mod(u*BigInteger.ModPow(v,3,P)%P*BigInteger.ModPow(Mod(u*BigInteger.ModPow(v,7,P)),(P-5)/8,P));
        var check=Mod(v*x*x);
        if(check!=u){if(check==Mod(-u))x=Mod(x*SqrtMinusOne);else return null;}
        if(x.IsZero&&odd)return null;
        if(!x.IsEven!=odd)x=Mod(-x);
        return (x,y);
    }
    static byte[] Encode((BigInteger X,BigInteger Y) point) {
        var bytes=new byte[32];point.Y.TryWriteBytes(bytes,out _,isUnsigned:true,isBigEndian:false);
        if(!point.X.IsEven)bytes[31]|=0x80;return bytes;
    }
}
